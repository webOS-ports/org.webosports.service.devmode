console.error("Starting to load libraries");

if (typeof require === "undefined") {
    require = IMPORTS.require;
}

var fs = require('fs');

console.error("---------> Loaded Libraries OK");
