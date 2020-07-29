// Redirect URL to pass to Dropbox. Has to be whitelisted in Dropbox settings
OAUTH_REDIRECT_URL='http://localhost:3000/auth';

// Libraries used during authentication
crypto = require('crypto'), // To create random state values for OAuth
NodeCache = require( "node-cache" ), // To cache OAuth state parameter

// Libraries to manipulate images and the File System
Jimp = require('jimp'), // Library to manipulate images
fs = require('fs'), // To read the file system

// Dropbox libraries
Dropbox = require('dropbox').Dropbox,
fetch = require('isomorphic-fetch');

// Constants required to recreate image paths
const 
backend_path = "public/images/",
client_path = "images/";

const mycache = new NodeCache();

//-- ROUTED FUNCTIONS --

module.exports.home = async (req, res)=>{
  
  let dbx = getDropboxInstance(req);

  if(!req.session.token){
    authorize(dbx,req,res);
  } else {
    // If no file selected instruct user to pick one
    if(!req.session.dbx_file){
      res.send("You need to pick a file from Dropbox");
    }
    // If user was already editing an image, present it
    else if(req.session.dbx_file.cached){
      presentImages(req,res);
    }
    //If user started the edit flow, but was redirected to OAuth, download images
    else if (req.session.dbx_file.id){
      prepareImages(dbx,req,res);
    }
  }
}

// Redirect from Dropbox after OAuth
module.exports.auth = async (req, res)=>{
  if(req.query.error_description){
    console.log(req.query.error_description);
    res.status(500);
    return res.send("<h1>Error... yikes!</h1><p>Check your console!</p>");
  } 

  // OAuth state value is only valid for 10 minutes
  // Session that created the state should be the same as the current session
  let state = req.query.state;
  let session_id = mycache.get(state);
  if(!session_id){
    res.status(440);
    return res.send("<h1>Authentication timeout, please try again</p>");
  }else if (session_id != req.session.id){
    res.status(500);
    console.log("Authorization flow was started under a different session");
    return res.send("<h1>Error... yikes!</h1><p>Check your console!</p>");
  }

  if(req.query.code){

    let dbx = getDropboxInstance(req);

    try{

      let token =  await dbx.getAccessTokenFromCode(OAUTH_REDIRECT_URL, req.query.code);
     
      // Store token and invalidate the state
      req.session.token = token;
      mycache.del(state);

      // Get the root_namespace for the user
      // Ensures that this flow works for Dropbox Business users team spaces
      // More info https://www.dropbox.com/developers/reference/namespace-guide
      dbx.setAccessToken(token);
      let account = await dbx.usersGetCurrentAccount();
      req.session.root_namespace_id = account.root_info.root_namespace_id;

      // Additionally save the user name to display it later
      req.session.name = account.name.given_name;

      res.redirect('/');

    }catch(error){
      console.log(error);
      res.status(500);
      res.send("<h1>Error... yikes!</h1><p>Check your console!</p>");   
    }
  }
}

// Called when a file action is triggered by Dropbox
module.exports.fileAction = (req,res)=>{ 

  // A file_id is required
  if(!req.query.file_id){
    res.status(400);
    return res.send("<h1>This action requires a file_id</p>"); 
  }

  let dbx = getDropboxInstance(req);

  // Store the file_id in the current session
  req.session.dbx_file = {
      id : req.query.file_id
    }

  // If cookies are cleared or session expires we need to authenticate again
  if(!req.session.token){
    authorize(dbx,req,res);
  }else{
    prepareImages(dbx,req,res);
  }
}

// Saves the edited file in the current session to Dropbox in the same folder
module.exports.saveToDropbox = async (req,res)=>{

  let dbx =  getDropboxInstance(req);

  let file_id = req.session.dbx_file.id;
  let file_name = req.session.dbx_file.name;
  let path_lower = req.session.dbx_file.path_lower;

  // Append an edited note to the name of the file before the file extension
  let dbx_save_path = path_lower.replace(/\./g,"(edited - FlipImage).");

  // Server location of the flipped image
  let flipped_img_path = backend_path + file_id + "_flipped_" + file_name;

  try{

    let content = fs.readFileSync(flipped_img_path); 

    let upload_params = {
      'contents': content,
      'path' : dbx_save_path,
      'strict_conflict': true, // Force to create a copy
      'autorename': true // Autorename if a copy is created
    }

    // UPload file and wait for it to be finished
    let upload_response = await dbx.filesUpload(upload_params);

    // Grab a link so we can send the user back to Dropbox
    let sharedlink_response = await dbx.sharingCreateSharedLinkWithSettings({'path': upload_response.id});

    // Cleanup the session upon success and redirect user to Dropbox
    req.session.dbx_file = null;
    res.redirect(sharedlink_response.url);

  }catch(error){
    // You should handle here possible Dropbox related errors
    // See Dropbox documentation for possible errors
    console.log(error);
    res.status(500);
    res.send("<h1>Error... yikes!</h1><p>Check your console!</p>"); 
  }

}

// -- INTERNAL FUNCTIONS --

// Kick starts the OAuth code exchange
function authorize(dbx,req,res,require_role){
  // Create a random state value
  let state = crypto.randomBytes(16).toString('hex');
  // Save state and the session id for 10 mins
  mycache.set(state, req.session.id, 6000);
  // Get authentication URL and redirect
  authUrl = dbx.getAuthenticationUrl(OAUTH_REDIRECT_URL, state, 'code');
  // Attach a require_role parameter if present
  if(req.query.require_role){
    authUrl = authUrl + "&require_role=" + req.query.require_role;
  }

  res.redirect(authUrl);
}

// Gets a new instance of Dropbox for this user session
function getDropboxInstance(req){

  let dbx_config = {
    fetch: fetch,
    clientId: process.env.DBX_APP_KEY,
    clientSecret: process.env.DBX_APP_SECRET
  };

  let dbx = new Dropbox(dbx_config);

  // Set the root namespace for this user
  // Ensures that this flow works for Dropbox Business users team folders
  // More info https://www.dropbox.com/developers/reference/namespace-guide
  if(req.session.root_namespace_id){
    dbx.pathRoot = JSON.stringify({".tag": "root", "root": req.session.root_namespace_id});
  }

  if(req.session.token){
    dbx.setAccessToken(req.session.token);
  }

  return dbx;
}

// Downloads the original image from Dropbox and creates a flipped one
// Both will be placed in a public folder that can be reached by client
async function prepareImages(dbx,req,res){
  
  try{

    // Download file using the file_id as path
    let response = await dbx.filesDownload({'path':req.session.dbx_file.id});

    // Additional information needed when file is saved back
    let file_name = response.name;
    req.session.dbx_file.name = file_name;

    let path_lower = response.path_lower;
    req.session.dbx_file.path_lower = path_lower;

    // First download the file and put it in the local public folder
    let original_temp_name = req.session.dbx_file.id + "_" + file_name;
    fs.writeFileSync(backend_path + original_temp_name, response.fileBinary);
    
    // Then create a flipped copy using JIMP
    let img_copy = await Jimp.read(backend_path + original_temp_name);
    await img_copy.flip(true,true);
    let flipped_temp_name = req.session.dbx_file.id + "_flipped_" + file_name;
    await(img_copy.writeAsync(backend_path + flipped_temp_name));

    // Indicate files have been downloaded 
    req.session.dbx_file.cached = true;

    presentImages(req,res);

  }catch(error){

    // Dropbox tokens are short lived, so if expired grab a new one
    if(error.response && error.response.status == 401){
      authorize(req,res);
    }else{
      // You should handle here possible Dropbox download related errors
      // See Dropbox documentation for possible errors
      // https://dropbox.github.io/dropbox-sdk-js/global.html#FilesLookupError
      console.log(error);
      res.status(500);
      res.send("<h1>Error... yikes!</h1><p>Check your console!</p>"); 
    }
  }
}

// Presents the images to the user
function presentImages(req,res){

  let original_temp_name = req.session.dbx_file.id + "_" + req.session.dbx_file.name;
  let flipped_temp_name = req.session.dbx_file.id + "_flipped_" + req.session.dbx_file.name;

  let args = {
    dropbox_name: req.session.name,
    image_original_path: client_path + original_temp_name,
    image_transformed_path: client_path + flipped_temp_name
  }

  res.render('index', args);
}