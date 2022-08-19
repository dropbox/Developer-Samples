#!/usr/bin/env python3

"""Example code for uploading a local folder of files to Dropbox using the Dropbox API in a
performant manner."""

from concurrent.futures import ThreadPoolExecutor

import configparser
import logging
import os
import time

import dropbox

logging.basicConfig()
logging.getLogger().setLevel(logging.DEBUG)

MB = 1024 * 1024


def get_client(config):
    """Returns the Dropbox client to use to upload files."""

    if not (
        config.get('AUTHORIZATION', 'access_token', fallback=None) or
        config.get('AUTHORIZATION', 'refresh_token', fallback=None)
        ):
        raise Exception("Either an access token or refresh token/app key is required.")

    if config.get('AUTHORIZATION', 'refresh_token', fallback=None):
        if not config.get('AUTHORIZATION', 'app_key', fallback=None):
            raise Exception("App key is required when using a refresh token.")
        return dropbox.Dropbox(
            oauth2_refresh_token=config.get('AUTHORIZATION', 'refresh_token', fallback=None),
            app_key=config.get('AUTHORIZATION', 'app_key', fallback=None),
            # the app secret is required for refresh tokens not acquired using PKCE
            app_secret=config.get('AUTHORIZATION', 'app_secret', fallback=None)
        )

    return dropbox.Dropbox(
        oauth2_access_token=config.get('AUTHORIZATION', 'access_token', fallback=None)
    )


def collect_files(folder_path):
    """Returns the list of files to upload."""

    folder_path = os.path.expanduser(folder_path)

    # List all of the files inside the specified folder.
    files = sorted(
        [os.path.join(folder_path, f)
         for f in os.listdir(folder_path)
         if os.path.isfile(os.path.join(folder_path, f))  # ignores folders
         and f not in [".DS_Store", ".localized", ".gitignore"]  # ignores system files, etc.
         ]
    )

    logging.info(f"Collected {str(len(files))} files for upload: {files}")

    return files


def upload_session_appends(client, session_id, source_file_path, config):
    """Performs parallelized upload session appends for one file."""

    futures = []

    dest_file_name = os.path.basename(source_file_path)
    dest_folder = config.get('PATHS', 'remote_path').lstrip("/")

    logging.info(f"Using upload session with ID '{session_id}' for file '{dest_file_name}'.")

    with open(source_file_path, "rb") as local_file:

        file_size = os.path.getsize(source_file_path)

        def append(dest_file_name, data, cursor, close):
            logging.debug(f"Appending to upload session with ID '{cursor.session_id}'"
                          f" for file '{dest_file_name}'"
                          f" at offset: {str(cursor.offset)}")
            client.files_upload_session_append_v2(f=data,
                                                  cursor=cursor,
                                                  close=close)
            logging.debug(f"Done appending to upload session with ID '{cursor.session_id}'"
                          f" for file '{dest_file_name}'"
                          f" at offset: {str(cursor.offset)}")

        if file_size > 0:  # For non-empty files, start a number of concurrent append calls.
            with ThreadPoolExecutor(
                max_workers=config.getint('LIMITS', 'concurrent_thread_count')
            ) as session_executor:
                while local_file.tell() < file_size:
                    cursor = dropbox.files.UploadSessionCursor(
                        session_id=session_id, offset=local_file.tell())
                    data = local_file.read(config.getint('LIMITS', 'chunk_size'))
                    close = local_file.tell() == file_size
                    futures.append(
                        session_executor.submit(append, dest_file_name, data, cursor, close))
        else:  # For empty files, just call append once to close the upload session.
            cursor = dropbox.files.UploadSessionCursor(session_id=session_id, offset=0)
            append(dest_file_name=dest_file_name, data=None, cursor=cursor, close=True)

        for future in futures:
            try:
                future.result()
            except Exception as append_exception:
                logging.error(f"Upload session with ID '{cursor.session_id}' failed.")
                raise append_exception

        return dropbox.files.UploadSessionFinishArg(
            cursor=dropbox.files.UploadSessionCursor(
                session_id=session_id, offset=local_file.tell()),
            commit=dropbox.files.CommitInfo(path=f"/{dest_folder}/{dest_file_name}"))


def upload_files(client, files, config):
    """Performs upload sessions for a batch of files in parallel."""

    futures = []
    entries = []
    uploaded_size = 0

    assert len(entries) <= 1000, "Max batch size is 1000."
    assert config.getint('LIMITS', 'chunk_size') % (4 * MB) == 0, \
        "Chunk size must be a multiple of 4 MB to use concurrent upload sessions"

    logging.info(f"Starting batch of {str(len(files))} upload sessions.")
    start_batch_result = client.files_upload_session_start_batch(
        num_sessions=len(files),
        session_type=dropbox.files.UploadSessionType.concurrent)

    with ThreadPoolExecutor(
        max_workers=config.getint('LIMITS', 'batch_thread_count')
    ) as batch_executor:
        for index, file in enumerate(files):
            futures.append(
                batch_executor.submit(
                    upload_session_appends,
                    client, start_batch_result.session_ids[index], file, config
                )
            )

    for future in futures:
        entries.append(future.result())
        uploaded_size += future.result().cursor.offset

    logging.info(f"Finishing batch of {str(len(entries))} entries.")
    finish_launch = client.files_upload_session_finish_batch(entries=entries)

    if finish_launch.is_async_job_id():
        logging.info(f"Polling for status of batch of {str(len(entries))} entries...")
        while True:
            finish_job = client.files_upload_session_finish_batch_check(
                async_job_id=finish_launch.get_async_job_id())
            if finish_job.is_in_progress():
                time.sleep(.5)
            else:
                complete = finish_job.get_complete()
                break
    if finish_launch.is_complete():
        complete = finish_launch.get_complete()
    elif finish_launch.is_other():
        raise Exception("Unknown finish result type!")

    logging.info(f"Finished batch of {str(len(entries))} entries.")

    for index, entry in enumerate(complete.entries):
        if entry.is_success():
            logging.info(f"File successfully uploaded to '{entry.get_success().path_lower}'.")
        elif entry.is_failure():
            logging.error(f"Commit for path '{entries[index].commit.path}'"
                          f" failed due to: {entry.get_failure()}")

    return uploaded_size


def run_and_time_uploads():
    """Performs and times the uploads for the folder of files."""

    config = configparser.ConfigParser()
    config.read('config.ini')

    client = get_client(config=config)
    files = collect_files(folder_path=config.get('PATHS', 'local_path'))

    start_time = time.time()
    uploaded_size = upload_files(client=client, files=files, config=config)
    end_time = time.time()

    time_elapsed = end_time - start_time
    logging.info(f"Uploaded {uploaded_size} bytes in {time_elapsed:.2f} seconds.")

    megabytes_uploaded = uploaded_size / MB
    logging.info(f"Approximate overall speed: {megabytes_uploaded / time_elapsed:.2f} MB/s.")


if __name__ == '__main__':
    run_and_time_uploads()
