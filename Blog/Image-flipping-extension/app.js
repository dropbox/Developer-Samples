require('dotenv').config({silent: true}); // read values from .env file

const
PORT = 3000, // Server port
controller = require('./controller.js'),
express = require('express'),
app = express(),
logger = require('morgan'), // Adding logging into the console
hbs = require('hbs'),  // Handlebars as view template 
session = require('express-session'); // Session management

// Session management initialization
// Uses local storage, for testing purposes only
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

// Temporary images will be placed in a public folder
// This code does not manage cleanup 
app.use(express.static('public')); 
app.use(logger('dev'));

// Handlebars set as the template engine 
app.set('view engine', 'hbs');

// Server routing or endpoints
app.get('/', controller.home); // home route
app.get('/auth', controller.auth); // OAuth redirect route
app.get('/dropbox_file_action',controller.fileAction); // Dropbox file actions route
app.get('/save',controller.saveToDropbox); // Save flipped image to Dropbox

// Start server
app.listen(PORT, () => console.log(`Extensions app listening on port ${PORT}!`));

