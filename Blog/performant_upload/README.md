# Performant Upload Example

This script demonstrates how to upload a large amount of data to Dropbox using [the Dropbox API](https://www.dropbox.com/developers/documentation/http/overview) via [the Dropbox Python SDK](https://github.com/dropbox/dropbox-sdk-python) in a performant manner. It aims to optimize the transfer speed by performing operations in parallel and using batch calls whenever possible, as described in [the Performance Guide](https://developers.dropbox.com/dbx-performance-guide).

### Getting Started

This script requires Python 3.6+ and a Dropbox access token (or refresh token) with the ability to write files.

Note that the script is configurable so that it can be tuned for different scenarios and environments. The provided example thread count settings are set high to create many threads to make use of very high bandwidth network connections, but may exhaust more limited machines/connections.

### Arguments

Read config.ini.example for a full list of the required parameters and their descriptions.

### Running the code

Example usage:
Fill in your parameters in a file named config.ini and then run:
```
python3 performant_upload.py
```

### License

Unless otherwise noted:

```
Copyright (c) 2022 Dropbox, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```