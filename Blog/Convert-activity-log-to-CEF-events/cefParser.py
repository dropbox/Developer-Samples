import requests, json, argparse, csv, datetime, socket, configparser

#Get audit log events
def getEvents(eventCategory, cursor):
    print("Pulling events...")
    headers = {"Authorization": "Bearer "+defaultConfig["dfbToken"], "Content-type": "application/json"}
    if cursor is not None:
        endpoint = "https://api.dropbox.com/2/team_log/get_events/continue"
        data = {"cursor": cursor}
    else:
        data = {"limit": args.limit}
        endpoint = "https://api.dropbox.com/2/team_log/get_events"
        if eventCategory:
            data['category'] = eventCategory   
        if args.end_time and args.start_time:
            data['time'] = {'start_time': args.start_time, 'end_time': args.end_time}
        elif args.end_time:
            data['time'] = {'end_time': args.end_time}
        elif args.start_time:
            data['time'] = {'start_time': args.start_time}
    response = requests.post(url=endpoint, headers=headers, data=json.dumps(data))

    try:
        response.raise_for_status()
        rbody = response.json()
        events = rbody['events']
        if rbody["has_more"]:
            events = events + getEvents(eventCategory, cursor=rbody["cursor"])[0]
        return (events, rbody["cursor"])
    except requests.exceptions.HTTPError as e:
        #Print details of non 200 response. Most likely bad token or event category
        print (e)

#Escape string values for CEF
def cleanData(eventData):
    data = str(eventData).strip()
    if len(data) > 0:
        data.replace('\\', '\\\\')
        data.replace('=', '\\=')
    if data == '{}':
        data = ''
    return data

#Make sure correct date format is provided
def validateDate(date):
    try:
        datetime.datetime.strptime(date, '%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise ValueError("Incorrect date format, should be '%Y-%m-%dT%H:%M:%SZ'")

#Built CEF formatted event from audit log event dictionary
def buildCEFEvent(eventDict):
    eventName = eventDict['event_type']['description']
    eventClassId = eventDict['event_type']['.tag']
    category = eventDict['event_category']['.tag']
    eventTS = datetime.datetime.strptime(eventDict['timestamp'],'%Y-%m-%dT%H:%M:%SZ')
    eventDetails = eventDict['details']
    eventActor = eventDict['actor']
    eventAssets = eventDict.get('assets',{})
    eventOrigin = eventDict.get('origin', {})
    ipAddress = eventOrigin.get('geo_location',{}).get('ip_address','')

    if eventDict['actor.tag'] in ['admin','user']:
        duser = eventDict['actor_info'].get('email','') 
        duid =eventDict['actor_info'].get('team_member_id','')
    else:
        duser = ''
        duid = ''

    extensionTemplate = "duser={duser} duid={duid} cat={cat} rt={receiptTime} end={end} cs1={cs1}, cs1Label=Details of event cs2={cs2} cs2Label=Details of event actor cs3={cs3} cs3Label=Details of the event origin src={ipAddress} cs4={cs4} cs4Label=Details of event assets"
    extensions = extensionTemplate.format(duser=duser, duid=duid, cat=category, receiptTime=eventTS.strftime('%b %d %Y %H:%M:%S'), end=eventTS.strftime('%b %d %Y %H:%M:%S'), 
        cs1=cleanData(eventDetails), cs2=cleanData(eventActor), cs3=cleanData(eventOrigin), ipAddress=ipAddress, cs4=cleanData(eventAssets))
    cef_event = cefTemplate.format(cefVersion=cefVersion, deviceVendor=deviceVendor, deviceProduct=deviceProduct, deviceVersion=deviceVersion, 
        eventClassID=eventClassId, name=eventName, severity=severity[category], extensions=extensions)
    return cef_event

#Write formatted cef events out to a csv
def writeEvents(events):
    with open('dropbox_cefevents.csv', mode='w') as cefEvents:
        print('Writing events to dropbox_cefevents.csv in current directory')
        csvwriter = csv.writer(cefEvents)
        csvwriter.writerows(events)

#Send syslog message via UDP
def sendEvents(events, host, port):
    level = 6 #Information
    facility = 3 #Daemon
    syslog_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for event in events:
        data = "<%d>%s" % (level + facility*8, event[0])
        syslog_socket.sendto(data.encode('utf-8'), (host, port))

#Pull out the relevant headers and content from raw events
def formatEvents(events):
    cef_events = []
    for event in events:
        formatEvent = {}
        eventHeaders = event.keys()
        for header in eventHeaders:
            formatEvent[header] = event[header]

            if header == 'actor':
                formatEvent[header+'.tag'] = event[header]['.tag']
                formatEvent[header+"_info"] = event[header].get('user', event[header].get('admin'))

        cef = buildCEFEvent(formatEvent)
        cef_events.append([cef])
    return cef_events

def main():
    if args.end_time:
        validateDate(args.end_time)
    if args.start_time:
        validateDate(args.start_time)
    result = getEvents(args.category, args.cursor)
    events = formatEvents(result[0])
    if args.output == True:
        writeEvents(events)
    if (args.host and args.port) is not None:
        print("Sending " +str(len(events))+ " activity log events")
        sendEvents(events, args.host, args.port)
    print("Event cursor: "+ result[1])

if __name__ == '__main__':
    #Setting up argument parser for command-line options
    parser = argparse.ArgumentParser(description='Provide your Dropbox Business API App token and pull events from the Dropbox audit log to send to syslog server.')
    parser.add_argument('-c','--category', help='The category of events you want to pull from audit log.',
                        choices=['apps', 'comments', 'devices', 'domains', 'file_operations', 'file_requests', 'groups', 'logins', 'members', 'paper', 
                        'passwords', 'reports', 'sharing', 'showcase', 'sso', 'team_folders', 'team_policies', 'team_profile', 'tfa', 'trusted_teams'], default='')
    parser.add_argument('-l','--limit', help='The max amount of events to pull from the audit log at one time, default is 1000.', default=1000, type=int)
    parser.add_argument('--output', help='Passing this will print a csv file of your query to your current directory named dropbox_cefevents.csv', dest='output', action='store_true')
    parser.add_argument('--host', help='The host address for the designated syslog destination to send events.',type=str)
    parser.add_argument('--port', help='The port address for the designated syslog destination to send events.',type=int)
    parser.add_argument('-st','--start_time', help='The starting time from when to include events (inclusive), format="%%Y-%%m-%%dT%%H:%%M:%%SZ"')
    parser.add_argument('-et','--end_time', help='The end time from when to include events (exclusive), format="%%Y-%%m-%%dT%%H:%%M:%%SZ"')
    parser.add_argument('-csr', '--cursor', help='Pass event cursor from activity log, to pull new events from last query.', default=None)
    parser.set_defaults(output=False)
    args = parser.parse_args()

    #Reading from settings
    config = configparser.ConfigParser()
    config.read("parserSettings.ini")
    defaultConfig= config['DEFAULT']


    #Severity Mapping
    severity = {"comments":0, "paper":1, "showcase":1, "file_requests":2, "file_operations":3, "devices":4, "sharing":4, "team_profile":5, "apps":5,
                "groups":5, "domains":6, "team_folders":6, "logins": 6, "members": 6, "passwords":7, "reports":7, "sso":7, "trusted_teams":7, "team_policies":9, "tfa":9}

    #Static CEF Info
    cefTemplate = 'CEF:{cefVersion}|{deviceVendor}|{deviceProduct}|{deviceVersion}|{eventClassID}|{name}|{severity}|{extensions}'
    deviceVendor = 'Dropbox'
    cefVersion = '0'
    deviceProduct = 'Dropbox Activity Log'
    deviceVersion = '1'
    main()
