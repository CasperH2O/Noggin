'use strict';
// Noggin, a BE/5x1 custom skill for Jibo.
var jibo = require('jibo'), BeSkill = require('@be/be-framework').BeSkill;
var createScreen = require('./lib/screen');

module.exports = createScreen(jibo, BeSkill);
