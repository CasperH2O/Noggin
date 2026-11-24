// SPDX-License-Identifier: MIT
// Noggin: everything Jibo says as fixed text, in each language he speaks. The model's own replies
// come in the conversation's language; these are the lines Noggin says itself: trouble, the
// budget heads-up, the dance announcements and the default greeting and comeback line.
// Plain words only: they are spoken like any other line, Dutch through the Dutch Voice skill
// (lib/voice.js). Node 6 / Chrome 53: ES2015 only.
'use strict';

const LANGUAGES = ['en', 'nl'];

const LINES = {
    en: {
        greeting: 'Hi!',
        comeback: 'Anything else?',
        'trouble.no_key': 'I need a brain before we can talk. Scan the code on my screen to give me one.',
        'trouble.key_refused': 'My key to OpenAI doesn\'t work anymore. Scan the code on my screen to fix it.',
        'trouble.settings': 'My settings need a look. Scan the code on my screen.',
        'trouble.no_credit': 'I\'ve run out of thinking money. Ask a grown-up to top up my OpenAI account.',
        'trouble.no_internet': 'I can\'t reach the internet right now. Is the Wi-Fi okay?',
        'trouble.openai_down': 'My brain is out of reach right now. Let\'s try again in a bit.',
        'trouble.rate_limited': 'I need a minute to catch my breath.',
        'trouble.permission': 'I\'m not allowed to do that. A grown-up can install me again in BEacon and agree to what I need.',
        'trouble.permission_network': 'I\'m not allowed to reach that address. A grown-up can change the address on my settings page.',
        'trouble.unknown': 'Sorry, I can\'t think straight right now. Let\'s talk again a bit later.',
        ready: 'Got it! Let\'s talk.',
        later: 'I\'ll be here when you\'re ready.',
        lostThread: 'Oops, I lost my train of thought. Could you say that again?',
        budget: 'Heads up: my thinking money for this month is nearly used up. Ask a grown-up to have a look.',
        micFailed: 'Sorry, I can\'t hear anything right now. Let\'s try again later.',
        // Only ever said in English: Dutch is what is missing or failing (D172).
        dutchMissing: 'My Dutch voice isn\'t ready, so let\'s talk in English for now.',
        dutchFailed: 'Sorry, my Dutch voice isn\'t working right now. Let\'s go on in English.',
        'dance.funk': ['Time to get funky!', 'Here comes the funk!', 'Feel the groove!'],
        'dance.pop': ['Here is my pop dance!', 'Pop star mode!', 'This one is catchy!'],
        'dance.robot': ['Here is my robot dance!', 'Robot mode: on!', 'Beep boop, robot dance!'],
        'dance.techno': ['Turn it up!', 'Time to rave!', 'Here is my techno dance!'],
        'dance.twerk': ['Watch me twerk!', 'Shake it!', 'Here is my twerk!'],
        'dance.belly': ['Here is my belly dance!', 'Belly dance time!', 'Watch these moves!'],
        'dance.flamenco': ['Ole!', 'Here is my flamenco!', 'A little flamenco!'],
        'dance.country': ['Yee haw!', 'Grab your boots!', 'Here is my country dance!'],
        'dance.slow': ['Here is a slow one.', 'Something smooth.', 'Time for a slow dance.'],
        'dance.calm': ['Something calm.', 'Very zen.', 'A peaceful little dance.'],
        'dance.silly': ['Here is a silly one!', 'This one is goofy!', 'Try not to laugh!'],
        'dance.waltz': ['May I have this dance?', 'Here is my waltz!', 'A little waltz!'],
        'dance.other': ['Here we go!']
    },
    nl: {
        greeting: 'Hoi!',
        comeback: 'Nog iets?',
        'trouble.no_key': 'Ik heb een brein nodig voordat we kunnen praten. Scan de code op mijn scherm om me er een te geven.',
        'trouble.key_refused': 'Mijn sleutel voor OpenAI werkt niet meer. Scan de code op mijn scherm om dat op te lossen.',
        'trouble.settings': 'Mijn instellingen moeten even nagekeken worden. Scan de code op mijn scherm.',
        'trouble.no_credit': 'Mijn denkgeld is op. Vraag een volwassene om mijn account bij OpenAI op te waarderen.',
        'trouble.no_internet': 'Ik kan het internet nu niet bereiken. Doet de wifi het wel?',
        'trouble.openai_down': 'Mijn brein is nu even onbereikbaar. Laten we het straks nog eens proberen.',
        'trouble.rate_limited': 'Ik moet even op adem komen.',
        'trouble.permission': 'Dat mag ik niet doen. Een volwassene kan me opnieuw installeren in BEacon en akkoord gaan met wat ik nodig heb.',
        'trouble.permission_network': 'Ik mag dat adres niet bereiken. Een volwassene kan het adres aanpassen op mijn instellingenpagina.',
        'trouble.unknown': 'Sorry, ik kan nu niet helder denken. Laten we straks weer praten.',
        ready: 'Gelukt! Laten we praten.',
        later: 'Ik ben er als je zover bent.',
        lostThread: 'Oeps, ik ben de draad kwijt. Kun je dat nog eens zeggen?',
        budget: 'Let op: mijn denkgeld voor deze maand is bijna op. Vraag een volwassene om even te kijken.',
        micFailed: 'Sorry, ik hoor nu niets. Laten we het later nog eens proberen.',
        'dance.funk': ['Tijd voor funk!', 'Hier komt de funk!', 'Voel de groove!'],
        'dance.pop': ['Hier is mijn popdans!', 'Ik ben een popster!', 'Deze is lekker pakkend!'],
        'dance.robot': ['Hier is mijn robotdans!', 'Robotstand: aan!', 'Biep boep, robotdans!'],
        'dance.techno': ['Zet hem harder!', 'Tijd voor een feestje!', 'Hier is mijn technodans!'],
        'dance.twerk': ['Kijk mij eens twerken!', 'Schudden maar!', 'Hier is mijn twerk!'],
        'dance.belly': ['Hier is mijn buikdans!', 'Tijd voor een buikdans!', 'Let op deze pasjes!'],
        'dance.flamenco': ['Ole!', 'Hier is mijn flamenco!', 'Een beetje flamenco!'],
        'dance.country': ['Jieha!', 'Pak je laarzen!', 'Hier is mijn countrydans!'],
        'dance.slow': ['Een langzaam dansje.', 'Iets soepels.', 'Tijd voor een slowdans.'],
        'dance.calm': ['Iets rustigs.', 'Heel zen.', 'Een vredig dansje.'],
        'dance.silly': ['Hier is een gekke!', 'Deze is mal!', 'Probeer niet te lachen!'],
        'dance.waltz': ['Mag ik deze dans van je?', 'Hier is mijn wals!', 'Een kleine wals!'],
        'dance.other': ['Daar gaan we!']
    }
};

function known(language) { return LANGUAGES.indexOf(language) >= 0 ? language : 'en'; }
// A fixed line in `language` (English when that language lacks it). A list picks one with `random`.
function say(key, language, random) {
    const own = LINES[known(language)][key], value = own === undefined ? LINES.en[key] : own;
    if (!Array.isArray(value)) return value === undefined ? '' : value;
    return value[Math.min(value.length - 1, Math.floor((random || Math.random)() * value.length))];
}
// The greeting and comeback line follow the language when they were not edited (D170): a Dutch
// default heard in an English conversation (the Dutch voice not ready) becomes the English one.
function firstLine(key, value, language) {
    const lang = known(language);
    return LANGUAGES.some(other => other !== lang && LINES[other][key] === value) ? LINES[lang][key] : value;
}

module.exports = {LANGUAGES, LINES, say, firstLine};
