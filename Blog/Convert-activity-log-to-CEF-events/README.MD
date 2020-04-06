# Convert Dropbox activity log to CEF events

This script can be used to transform Dropbox activity log events retrieved from the [team log endpoint](https://www.dropbox.com/developers/documentation/http/teams#team_log-get_events) to the [CEF standard](https://community.microfocus.com/t5/ArcSight-Connectors/ArcSight-Common-Event-Format-CEF-Implementation-Standard/ta-p/1645557?attachment-id=68077) developed by MicroFocus ArcSight.

### Getting Started

To use the script you will need to have a copy of Python 3.0+ and Dropbox Business access token with either the **"Team Auditing"** or **"Team Member File Access"** permission.

To get started with running the script you will need to paste your access token in the parserSettings.ini file as indicated. 

With your access token put in you can then proceed to run and execute the script simply by calling ```python cefParser.py``` and associated arguments. You can see the full list of arguments possible in the below section.


### Run Examples

**Objective**: Generate a CSV of CEF events for all single sign on events 
```
python cefParser.py --output --category sso
```

In this example passing in the argument --output will generate a CSV file of the events pulled.```--category``` or ```-c``` designates you want to filter on an event category and sso (single sign on) is the category filter.

**Objective**: Send all category of events to designated syslog server
```
python cefParser.py --host 121.121.01.10 --port 1234
```

Here you’re sending all events to the host and port you’ve designated, by using the ```--host``` and ```--port``` arguments.

**Objective**: Send all CEF events from 2018 up to 2019 to designated syslog server
```
python cefParser.py --host 121.121.01.10 --port 1234 --start_time 2018-01-01T00:00:00Z --end_time 2019-01-01T00:00:00Z
```

### Arguments
```'-c','--category'```: The category of events you want to pull from audit log. If no category is passed all events are pulled.  
```categories: 'apps', 'comments', 'devices', 'domains', 'file\_operations', 'file\_requests', 'groups', 'logins', 'members', 'paper', 'passwords', 'reports', 'sharing', 'showcase', 'sso', 'team\_folders', 'team\_policies', 'team\_profile', 'tfa', 'trusted\_teams'  ```
```'-l','--limit'```: The max amount of events to pull from the audit log at one time, default is 1000.  
```'--output'```: Passing this will print a csv file of your query to your current directory named dropbox\_cefevents.csv.  
```'--host'```: The host address for the designated syslog destination to send events.  
```'--port'```: The port address for the designated syslog destination to send events.  
```'-st','--start_time'```: The starting time from when to include events (inclusive), format=```%%Y-%%m-%%dT%%H:%%M:%%SZ```  
```'-et','--end_time'``` : The end time from when to include events (exclusive), format=```%%Y-%%m-%%dT%%H:%%M:%%SZ```  
```'-csr', '--cursor'```: Pass event cursor from activity log, to pull new events from last query.

### Licensing
The script within this folder is covered by the Apache License as described in LICENSE.txt.

##### Please carefully note: 

> "Disclaimer of Warranty. [...] the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License."