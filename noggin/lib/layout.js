'use strict';
// The classic Jibo look for 1280x720: colours, fonts and positions, copied from the 5x1 style
// guide (ui/jibo-ui-classic/tokens/tokens.json, see docs/apps/STYLEGUIDE-5X1.md). Each value
// names its token; PROPOSED marks a value that is not stock. No PIXI or DOM here, so it is unit
// tested directly.

var color = {
    text: '#FFFFFF',        // color.text
    muted: '#BBC6CA'        // color.mutedText
};
// Button gradients [highlight, shadow], as the SDK wants them (color.tileGradients.*).
var pairs = {
    action: [0x3765AB, 0x1A2563]    // tileGradients.blue
};
var font = {title: 'Proxima Nova Soft', body: 'Proxima Nova Light'};   // typography.families

var screen = {width: 1280, height: 720};
var title = {x: 640, y: 120, size: 80, width: 1120};    // stock dialog title size; y PROPOSED
var body = {x: 640, y: 220, size: 45, width: 1060};     // PROPOSED
var button = {x: 640, y: 440, size: 264};               // stock ActionButton, centred; y PROPOSED

var text = {
    title: 'Noggin',
    body: 'Tap the button and Jibo looks up.'
};

module.exports = {color: color, pairs: pairs, font: font, screen: screen, title: title, body: body, button: button, text: text};
