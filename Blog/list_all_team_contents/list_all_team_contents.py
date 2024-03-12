"""Example code for listing all entries in all namespaces accessible to a team."""

import configparser

import dropbox


def list_all_contents():
    """Lists the contents of each namespace accessible to a team."""

    config = configparser.ConfigParser()
    config.read("config.ini")

    # We'll first get a client for interacting with the team to list the namespaces
    with dropbox.DropboxTeam(
        app_key=config.get("DEFAULT", "app_key"),
        app_secret=config.get("DEFAULT", "app_secret"),
        oauth2_refresh_token=config.get("DEFAULT", "team_refresh_token"),
    ) as dbx_team:
        # The functionality for listing the namespaces may return duplicates,
        # so we'll use a set here to ensure uniqueness
        namespace_ids = set()

        def handle_namespaces_result(result):
            """Processes each page of namespaces."""
            for namespace in result.namespaces:
                namespace_ids.add(namespace.namespace_id)

        namespaces_result = dbx_team.team_namespaces_list()
        handle_namespaces_result(namespaces_result)

        # The interface for retrieving the list of namespaces is paginated,
        # so we need to make sure we retrieve and process every page of results
        while namespaces_result.has_more:
            namespaces_result = dbx_team.team_namespaces_list_continue(
                cursor=namespaces_result.cursor
            )
            handle_namespaces_result(namespaces_result)

        namespace_ids = sorted(list(namespace_ids), key=int)
        print(f"Received list of {len(namespace_ids)} namespaces for team.")

        # Now that we've retrieved all the namespaces,
        # we'll get an admin client to access those namespaces
        with dbx_team.as_admin(
            team_member_id=config.get("DEFAULT", "team_admin_member_id")
        ) as dbx_admin:

            def handle_listing_result(result):
                """Processes each page of file/folder entries.
                Refer to the documentation for information on how to use these entries:
                https://www.dropbox.com/developers/documentation/http/documentation#files-list_folder"""
                for entry in result.entries:
                    print(
                        f"\tReceived entry of type {type(entry)} "
                        f"at path: {entry.path_lower}"
                    )

            for namespace_id in namespace_ids:
                print(f"Listing namespace with ID: {namespace_id}")

                # For each namespace, we can make a client rooted to that namespace
                with dbx_admin.with_path_root(
                    dropbox.common.PathRoot.namespace_id(namespace_id)
                ) as dbx_admin_with_ns:

                    listing_result = dbx_admin_with_ns.files_list_folder(
                        # Because this client is rooted to this namespace,
                        # we use the empty string `""` as the `path` to
                        # list the root folder of this namespace
                        path="",
                        # Request a recursive listing to get nested entries as well
                        recursive=True,
                        # Skip mounted folders because they'll be in the namespace list
                        include_mounted_folders=False
                    )
                    handle_listing_result(listing_result)

                    # Just like with getting the list of namespaces,
                    # the interface for getting the list of contents of a folder is paginated,
                    # so we need to make sure we retrieve and process every page of results
                    while listing_result.has_more:
                        listing_result = dbx_admin_with_ns.files_list_folder_continue(
                            cursor=listing_result.cursor
                        )
                        handle_listing_result(listing_result)


if __name__ == "__main__":
    list_all_contents()
