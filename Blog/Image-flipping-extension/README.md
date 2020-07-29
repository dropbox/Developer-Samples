# Image Flipping Extension Sample

## Background

This code sample shows how to integrate [Dropbox Extensions](https://www.dropbox.com/lp/developers/reference/extensions-guide) into an application. It implements a minimalist web server able to handle multiple Dropbox users at the same time which receives actions from images in dropbox.com. Every time an action is triggered, it presents the original image selected and an upside down (flipped) version of it, along with a save option. When the user clicks on *save*, the flipped version is saved to Dropbox in the same path as the original image. Finally, a [shared link](https://www.dropbox.com/lp/developers/reference/dbx-sharing-guide) is created for the newly uploaded image, and the user is redirected to it.

This simplified example flips images upside down, but an app that has more complex file transformation or analysis would follow a similar pattern.

The code sample uses the following tech stack:
- The server is implemented using [Node.](https://nodejs.org/en/)[js](https://nodejs.org/en/) and [Express](https://expressjs.com/). The minimum version required for Node.JS is 8.2.1
-  [Handlebars](https://handlebarsjs.com/), which is a minimalist template engine that allows to load simple HTML within an .hbs file, and pass JavaScript objects to it.
- The Dropbox [JavaScript SDK](https://github.com/dropbox/dropbox-sdk-js) is used to make API calls to Dropbox

## Setting up the Dropbox App

Before you can successfully run the code from this repository, you first need to have a Dropbox application with a registered Extension. If you don’t have an application, create one in the Dropbox developer [App Console](https://www.dropbox.com/developers/apps). Note that only apps with *Full Dropbox* access can register an Extension.

If you are using a [*Scoped access*](https://www.dropbox.com/lp/developers/reference/oauth-guide#scopes) app, then you will need to mark at least the following permissions:

- files.content.read
- files.content.write
- sharing.write

## Setting up OAuth
This code sample implements OAuth code authentication flow allowing multiple users to authorize this application. For more information about implementing OAuth please refer to our [OAuth Guide](https://www.dropbox.com/lp/developers/reference/oauth-guide). To configure OAuth in your app you need to follow these two steps in the *Settings* tab in the App Console. 

1. Click on *Enable additional users* **if you haven’t already done so, and your app isn’t already in [production mode](https://www.dropbox.com/developers/reference/developer-guide#production-approval)

2. Enter the redirect URI http://localhost:3000/auth as shown in the following screenshot

![Redirect URI settings for extension sample](https://github.com/dropbox/developer-samples/blob/master/public/ext-redirect-settings.png?raw=true)

  
## Setting up the Extension

Now that the app is configured, you need to add the Extension. To do that, scroll down the *Settings* page and look for the *Extensions* section. For more information about setting up an Extension check out our [Extensions Guide](https://www.dropbox.com/lp/developers/reference/extensions-guide).

Add an Extension with the following configuration:
-  **Extension URI -** http://localhost:3000/dropbox_file_action
-  **What is the main purpose of this extension? -** Opening/Editing files
-  **Supported File Types -** .jpg, .jpeg, .png
-  **Max File Size (MB) -** 10

![Image flipping Extension settings](https://github.com/dropbox/developer-samples/blob/master/public/ext-settings.png?raw=true)

After you save it, click on *Edit*  ****to modify the extension and **uncheck** the *Only me* option in Visibility settings. This will allow the Extension to be presented to users who link their accounts via OAuth in the Open menu and connected apps page. The final configuration of your Extension should look just like this:

![Image flipping Extension settings with Visibility set to  "All linked users”](https://github.com/dropbox/developer-samples/blob/master/public/ext-all-linked-users.png?raw=true)

Now that the extension is configured, you should be able to see the extension **in your own Dropbox account** even without going through OAuth. To test it, in dropbox.com browse any image with one of the specified file types and then click on **Open→ Connect more apps → <YourAppName>**. This will trigger the file action and a new tab will be launched with the Extension URI you registered. After you link the app through OAuth, the extension will be displayed directly in the Open Menu and will be listed in the connected apps page as explained later.

## Running the code

Make sure Node.JS is installed on your machine, if that is not the case, you can go to [nodejs.org](https://nodejs.org/en/) and get the latest version. Anything above 8.2.1 would work.

This code sample consists of the following files:
-  **package.json** tracks metadata about node modules that the project needs
-  **app.js** entry point and application configuration
-  **controller.js** implements the code sample logic
-  **views/index.hbs** is the html page presented to user with the two images

First, you need to add a **.env** file in the root of the project (where the package.json file is). Paste the following content and replace the values with your information from the *Settings* tab of the App Console

**.env**
```
DBX_APP_KEY = '<USE KEY FROM APP CONSOLE>'
DBX_APP_SECRET = '<USE SECRET FROM APP CONSOLE>'
SESSION_SECRET = '<USE ANY RANDOM SECRET>'
```
Open a terminal and at the project level (where the package.json file is located) install the dependencies using: `npm install`

And then run the server: `npm start`

When a user navigates to our deployed server at http://localhost:3000, it will automatically kick off the Dropbox OAuth flow. Once authorized, the user will be redirected to a landing page asking them to go to dropbox.com and select a file.

At this point, any Dropbox account should be able to authorize this app in your local machine and see the sample extension on the Open dropdown of an image file. If you want to test several Dropbox users at the same time, you can do it in your local machine by running different web browsers or with the same web browser using different browser sessions (such as incognito mode or different Chrome profiles). You can also use localhost tunneling tools such as [ngrok](https://ngrok.com/) to test outside your local machine.

![Image flipping Extension authorization page](https://github.com/dropbox/developer-samples/blob/master/public/ext-auth.png?raw=true)

Now that the app has been authorized, the extension is available in the Open dropdown next to image files and is also listed in the Connected Apps page in the user’s Dropbox settings. When the extension is clicked from an image file, it will redirect them to the server we defined in the Extension settings and start the workflow in the images below.

![Sample Extension displayed on a file’s Open menu](https://github.com/dropbox/developer-samples/blob/master/public/ext-open-menu.png?raw=true)

![User interface for  “Flip my image” sample Extension](https://github.com/dropbox/developer-samples/blob/master/public/flipped-image-ui.png?raw=true)

When *Save to Dropbox* is clicked*,* the flipped image will be saved to Dropbox with the suffix (edited - FlipImage). The server also creates a Dropbox shared link and redirects the user to the link.

![Flipped image displayed through a Dropbox shared link](https://github.com/dropbox/developer-samples/blob/master/public/flipped-image-shared-link.png?raw=true)

# Important considerations

## OAuth
Extensions will only show up directly on a registered file type after the app has been authorized via OAuth. Authorized extensions can be seen and removed on the [*Connected apps*](https://www.dropbox.com/account/connected_apps) page of a user’s Dropbox settings. Extensions only pass the file identifier to the server, but any further action with the API requires a valid access token. The OAuth code flow presented in this code sample is well explained in a blog post called “[OAuth code flow implementation using Node.js and Dropbox JavaScript SDK](https://dropbox.tech/developers/oauth-code-flow-implementation-using-node-js-and-dropbox-javascript-sdk)”. For more details you can visit our [OAuth guide](https://www.dropbox.com/lp/developers/reference/oauth-guide).

## Web Sessions
Web sessions are fundamental in this code sample as they allow the server to manage multiple users at the same time independently. Any information relevant to the user’s workflow is stored in a temporary session on the server side, including the Dropbox access token, file and user information.

A session allows a user to resume an earlier workflow at any point. For instance, if you start an edit flow and close the window or navigate away, you can simply navigate back to http://localhost:3000/ to pick up where you left off.

In this code example, we’re using the [express-session](https://www.npmjs.com/package/express-session) library. By default, it uses local storage to save session information, which should **never be used on a production environment**. You’ll notice that once the server stops, the local storage is cleaned up. You can find compatible production stores in the library documentation. Additionally, we use non-secure cookies, which also shouldn’t be used in a production environment.

## Re-authorizing
As tokens are stored in a web session, they will be lost whenever users clean up cookies or when the current session expires. In addition, Dropbox scoped apps have rolled out [short lived tokens](https://www.dropbox.com/lp/developers/reference/oauth-guide#using-refresh-tokens), so these can be valid only for a few hours.

For both cases, expired or non existent tokens in the current session, users will need to be redirected again to the authorization process. The good news is that whenever a user has already authorized the app, they will be immediately redirected to the *Redirect URI* and bypass the authorization screen as long as the server has an **https** scheme. Because we use http on the localhost server in this example, you’ll see the authorization screen again each time you need to re-authorize. To test with https, you can use some localhost tunneling tool such as [ngrok](https://ngrok.com/), in which case you need to register the ngrok https redirect URL in the Dropbox App Settings page.

## Personal and work accounts

Some Dropbox users have a personal and work accounts linked together. For this case, at the authorization step the user will need to pick between either of those two. When an action is originated from a file in Dropbox a `require_role` parameter is passed along indicating which of the two accounts started the request. When the app requires a user to re-authorize as described in the section above, that parameter can be passed in the authorization call to preselect the correct account as shown in the image below.

![Authorization screen for users with linked personal and work Dropbox accounts](https://github.com/dropbox/developer-samples/blob/master/public/personal-work-auth.png?raw=true)

## Making it work for all Dropbox Business users

Dropbox Business users may have different folder organizational model as Dropbox has been gradually shifting to a new organization paradigm called [Team Spaces](https://help.dropbox.com/teams-admins/team-member/team-space-overview). You can read more about the two organizational models for Dropbox Business users in our Team File Guide. If we want to allow the user to access *all* content (including their Team Space), then we need to set the user’s namespace to match the team’s `root_namespace_id` to ensure that all content can be reached via the API.

In this code sample, getting the root namespace ID is done right after authorization in the `auth` method. This `root_namespace_id` is saved into the existing user session:

```
// Get the root_namespace for the user
let account = await dbx.usersGetCurrentAccount();
req.session.root_namespace_id = account.root_info.root_namespace_id;
```
When any new request is received on the server and the Dropbox object is instantiated, we set the `root_namespace_id` using the value stored in the session:
```
let dbx = new Dropbox(dbx_config);
// Set the root namespace for this user
if (req.session.root_namespace_id){
    dbx.pathRoot = JSON.stringify({".tag": "root", "root": req.session.root_namespace_id});
}
if (req.session.token){
    dbx.setAccessToken(req.session.token);
}
```
For more information, visit the Dropbox [Namespace Guide](https://www.dropbox.com/developers/reference/namespace-guide).

# Improvements to make
This code sample was created to demonstrate the interaction between the Dropbox API and a web server when using Dropbox Extensions. It also includes an implementation of OAuth and support sDropbox Business users with both organizational models, Team Spaces and Team Folders.

This code is meant for educational purposes only. When building for a similar use case in production, additional consideration is needed for the following topics:

- Cleaning up temporary images stored in the public/images folder
- Better error handling
- Input and output optimization
- Proper session storage and secure cookies
- Using https protocol

# License

Apache 2.0