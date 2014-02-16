console.error("Starting to load libraries");

if (typeof require === "undefined") {
    require = IMPORTS.require;
}

var fs = require('fs');
var spawn = require('child_process').spawn;

console.error("---------> Loaded Libraries OK");
