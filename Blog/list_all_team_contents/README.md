# Team Contents Listing Example

This script demonstrates how to list the contents of all of the namespaces accessible to a connected Dropbox team using the [the Dropbox API](https://www.dropbox.com/developers/documentation/http/overview) via [the Dropbox Python SDK](https://github.com/dropbox/dropbox-sdk-python). 

### Getting Started

This script requires Python 3.6+ and a Dropbox app key, app secret, and a refresh token for a team with the team_data.member and files.metadata.read scopes.

### Arguments

Read config.ini.example for a full list of the required parameters and their descriptions.

While a simple config file is used here as an example, be sure to always store sensitive values such as app secrets and refresh tokens securely.

### Running the code

Example usage:

Fill in your parameters in a file named config.ini and then run:
```
python3 list_all_team_contents.py
```

### License

Unless otherwise noted:

```
Copyright (c) 2024 Dropbox, Inc.

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