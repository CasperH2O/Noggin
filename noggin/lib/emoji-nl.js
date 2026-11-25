// SPDX-License-Identifier: MIT
// Noggin: Dutch words for the eye emoji. Each Dutch word or two-word term points at a term of the
// English emoji index (catalog.json `emoji`), so both languages show the same pictures. Words are
// lower case without accents (lookup strips them: "pinguïn" -> "pinguin"). Plurals and
// diminutives are found by catalog.emojiFor ("honden", "hondje" -> hond). Left out on purpose:
// words with a common second meaning ("bank" is also a sofa, "golf" a wave, "kussen" to kiss,
// "slot" an ending, "ruimte" room, "hart" in "van harte", "burger" a citizen, "succes" success),
// and "chip" ("chips" are crisps).
// Node 6 / Chrome 53: ES2015 only.
'use strict';

const TERMS = {
    // travel, vehicles
    vliegtuig: 'airplane', vliegveld: 'airport', luchthaven: 'airport', fiets: 'bicycle', fietsen: 'biking',
    boot: 'boat', bus: 'bus', schoolbus: 'school bus', taxi: 'taxi', auto: 'car', vrachtwagen: 'truck',
    voertuig: 'vehicle', raket: 'rocket', ruimteschip: 'rocketship', lancering: 'blast off', reis: 'travel', reizen: 'travel',
    ufo: 'ufo', benzine: 'gasoline',
    // animals
    alien: 'alien', alligator: 'alligator', mier: 'ant', vogel: 'bird', roodborstje: 'robin', buffel: 'buffalo',
    konijn: 'rabbit', kat: 'cat', poes: 'cat', katje: 'kitten', kitten: 'kitten', poesje: 'kitten', vee: 'cattle',
    kuiken: 'chick', kip: 'chicken', koe: 'cow', koeien: 'cow', hond: 'dog', puppy: 'puppy', 'franse bulldog': 'french bulldog',
    ezel: 'donkey', olifant: 'elephant', vis: 'fish', flamingo: 'flamingo', aap: 'monkey', muis: 'mouse',
    pinguin: 'penguin', huisdier: 'pet', varken: 'pig', biggetje: 'piggy', rat: 'rat', reptiel: 'reptile',
    knaagdier: 'rodent', haai: 'shark', schaap: 'sheep', ooievaar: 'stork', schildpad: 'turtle', kalkoen: 'turkey animal',
    walvis: 'whale', insect: 'insect', bug: 'bug', ongedierte: 'vermin',
    // food and drink
    alcohol: 'alcohol', appel: 'apple', 'groene appel': 'green apple', 'rode appel': 'red apple', spek: 'bacon', bacon: 'bacon',
    bier: 'beer', ontbijt: 'breakfast', hamburger: 'hamburger', cheeseburger: 'cheeseburger',
    taart: 'cake', cake: 'cake', snoep: 'candy', zuurstok: 'candy cane', wortel: 'carrot', kaas: 'cheese',
    'zwitserse kaas': 'swiss cheese', kippenvleugel: 'chicken wing', chocolade: 'chocolate', chocola: 'chocolate',
    koffie: 'coffee', zuivel: 'dairy', toetje: 'dessert', nagerecht: 'dessert', dessert: 'dessert', avondeten: 'dinner',
    diner: 'dinner', ei: 'egg', eieren: 'egg', fruit: 'fruit', jus: 'gravy', ham: 'ham', hotdog: 'hot dog',
    'warme drank': 'hot drink', ijs: 'ice cream', ijsje: 'ice cream', ijsblokje: 'ice cube', lunch: 'lunch',
    macaroni: 'macaroni', vlees: 'meat', melk: 'milk', taco: 'taco', pizza: 'pizza', popcorn: 'popcorn',
    pretzel: 'pretzel', krakeling: 'pretzel', pompoen: 'pumpkin', pompoentaart: 'pie pumpkin', boterham: 'sandwich',
    tosti: 'sandwich', zeevruchten: 'seafood', soep: 'soup', sushi: 'sushi', thee: 'tea', groente: 'vegetable',
    watermeloen: 'watermelon', wijn: 'wine', boodschappen: 'groceries', restaurant: 'restaurant', cafe: 'cafe',
    // home and things
    badkamer: 'bathroom', bad: 'bath', badkuip: 'bathtub', batterij: 'battery', accu: 'battery', bed: 'bed',
    bedtijd: 'bedtime', boek: 'book', fles: 'bottle', gloeilamp: 'light bulb', lamp: 'lightbulb', rekenmachine: 'calculator',
    camera: 'camera', klok: 'clock', kleren: 'clothes', kleding: 'clothing', computer: 'computer', laptop: 'laptop',
    computerchip: 'computer chip', microchip: 'microchip', processor: 'cpu', circuit: 'circuit', stopcontact: 'outlet',
    stekker: 'plug', elektriciteit: 'electricity', elektrisch: 'electric', telefoon: 'phone', mobiel: 'cell phone',
    mobieltje: 'cell phone', telefoontje: 'phone call', bril: 'glasses', zonnebril: 'sunglasses', hoed: 'hat',
    'hoge hoed': 'top hat', huis: 'house', keuken: 'kitchen', mes: 'knife', hangslot: 'lock', microfoon: 'microphone',
    geld: 'money', contant: 'cash', dollar: 'dollar', spaarvarken: 'piggy bank', betaling: 'payment', hoofdkussen: 'pillow',
    jurk: 'dress', broek: 'pants', spijkerbroek: 'jeans', trui: 'sweater', kersttrui: 'holiday sweater', sokken: 'socks',
    sok: 'socks', wanten: 'mittens', handtas: 'purse', paraplu: 'umbrella', stofzuiger: 'vacuum', wasmachine: 'washing machine',
    wasgoed: 'laundry', broodrooster: 'toaster', televisie: 'television', tv: 'television', toilet: 'toilet', wc: 'restroom',
    wcpapier: 'toilet paper', toiletpapier: 'toilet paper', gereedschap: 'tools', reparatie: 'repairs', klusjes: 'chores',
    afval: 'rubbish', vuilnis: 'trash', prullenbak: 'trash can', vuilnisbak: 'trash can', robot: 'robot',
    kaartjes: 'tickets', tickets: 'tickets', thermometer: 'thermometer', temperatuur: 'temperature', radar: 'radar',
    vergrootglas: 'magnifying glass', diamant: 'diamond', kroon: 'crown', trofee: 'trophy', medaille: 'olympic medal',
    ballon: 'balloons', ballonnen: 'balloons', pleister: 'bandaid', ehbo: 'firstaid', lantaarn: 'lantern',
    // nature and weather
    strand: 'beach', kust: 'shore', zee: 'sea', oceaan: 'ocean', woestijn: 'desert', aarde: 'earth', tuin: 'garden',
    bloem: 'flower', 'blauwe bloem': 'blue flower', 'rode bloem': 'red flower', 'witte bloem': 'white flower',
    'roze bloem': 'flower pink', madeliefje: 'daisy', tulp: 'tulip', plant: 'plant', boom: 'tree', klaver: 'clover',
    'klavertje vier': 'four leaf clover', berg: 'mountain', bergen: 'mountains', maan: 'moon', planeet: 'planet',
    mars: 'mars', saturnus: 'saturn', heelal: 'outer space', zon: 'sun', zonnig: 'sunny', zonneschijn: 'sunshine',
    wolk: 'clouds', wolken: 'clouds', bewolkt: 'cloudy', regen: 'rain', regenwolk: 'rain cloud', regenboog: 'rainbow',
    sneeuw: 'snow', sneeuwvlok: 'snowflake', sneeuwpop: 'snowman', storm: 'storm', onweer: 'thunderstorm',
    donder: 'thunder', bliksem: 'lightning', bliksemschicht: 'lightning bolt', vuur: 'fire', brand: 'fire', vlam: 'flame',
    kampvuur: 'campfire', ijskoud: 'freezing', vriezen: 'freezing', kokend: 'boiling', nat: 'wet', zomer: 'summer',
    winter: 'winter', 'heldere nacht': 'clear night',
    // sports, play, music, art
    halter: 'barbell', honkbal: 'baseball', basketbal: 'basketball', bowlen: 'bowling', boksen: 'boxing',
    duiken: 'diving', sporten: 'exercise', vissen: 'fishing', golfen: 'golf', midgetgolf: 'mini golf',
    sportschool: 'gym', wandelen: 'hiking', hockey: 'hockey', schaatsen: 'iceskate', voetbal: 'soccer',
    snowboard: 'snowboard', snorkel: 'snorkel', zwemmen: 'swimming', tennis: 'tennis', gewichtheffen: 'weightlifting',
    skis: 'skis', puzzel: 'puzzle', legpuzzel: 'jigsaw puzzle', puzzelstukje: 'puzzle piece', gamen: 'gaming',
    videogame: 'video game', gitaar: 'guitar', muziek: 'music', muzieknoot: 'music note', muzikant: 'musician',
    maracas: 'maracas', disco: 'disco', discobal: 'disco ball', film: 'movie', films: 'movies', fotografie: 'photography',
    foto: 'picture', tekening: 'drawing', tekenen: 'drawing', schets: 'sketch', krabbel: 'doodle', verf: 'paint',
    schilderen: 'paint', palet: 'palette', schildersezel: 'easel', magie: 'magic', toveren: 'magic', feest: 'party',
    applaus: 'applause', klappen: 'clap', applaudisseren: 'clapping', zwaaien: 'waving',
    // school, work, body, people
    school: 'school', huiswerk: 'homework', leraar: 'teacher', lerares: 'teacher', juf: 'teacher', schoolbord: 'chalkboard',
    krijtbord: 'chalkboard', onderwijs: 'education', diploma: 'graduation', leren: 'learning', lezen: 'reading',
    bibliotheek: 'library', literatuur: 'literature', wetenschap: 'science', einstein: 'einstein', hersenen: 'brain',
    brein: 'brain', spier: 'muscle', spieren: 'muscle', snor: 'mustache', baby: 'baby', astronaut: 'astronaut',
    engel: 'angel', onschuldig: 'innocent', spook: 'ghost', mode: 'fashion', verkleden: 'dress up',
    winkel: 'shop', winkelen: 'shopping', winkelcentrum: 'mall', supermarkt: 'supermarket', markt: 'market',
    boerderij: 'farm', slapen: 'sleep',
    // luck, signs, feelings
    geluk: 'luck', 'veel succes': 'good luck', duimen: 'fingers crossed', 'duim omhoog': 'thumbs up',
    duimpje: 'thumbs up', 'duim omlaag': 'thumbs down', 'gebroken hart': 'broken heart', 'rood hart': 'red heart',
    'blauw hart': 'blue heart', regenboogvlag: 'pride flag', vuurwerk: 'fireworks',
    // places, holidays
    amerika: 'america', 'amerikaanse vlag': 'american flag', canada: 'canada', egypte: 'egypt', piramide: 'pyramid',
    nasa: 'nasa', verjaardag: 'birthday', jarig: 'birthday', kerst: 'christmas', kerstmis: 'christmas',
    kerstboom: 'christmas tree', kerstman: 'santa claus', kerstbal: 'ornament', maretak: 'mistletoe', kerstsok: 'stocking',
    pasen: 'easter', paasei: 'easter egg', halloween: 'halloween', chanoeka: 'hanukkah', ramadan: 'ramadan',
    nieuwjaar: 'new years', oudjaar: 'new years', valentijnsdag: 'valentines day', cupido: 'cupid'
};

// Words that, within two words of an emoji word, mean something else ("appel" next to "iphone").
const CANCEL = {
    appel: ['computer', 'computers', 'iphone', 'ipad', 'mac', 'macbook', 'watch', 'bedrijf'],
    muis: ['computer', 'klik', 'klikken', 'toetsenbord'],
    bug: ['software', 'code', 'programma', 'computer', 'app'],
    brand: ['merk'], vuur: ['open'], film: ['plastic'], mode: ['donkere', 'lichte', 'stille'],
    jus: ['orange'], ijs: ['vijver', 'glad', 'dun', 'dunne', 'schaatsen', 'gevroren']
};

// Words that look like a plural or diminutive of a listed word but are not ("Engels" is English,
// not angels; "gelden" is a verb; "zonen" are sons; a "kastje" is a cupboard).
const NOT = ['engels', 'gelden', 'zonen', 'kastje', 'kastjes', 'natje', 'natjes'];

module.exports = {TERMS, CANCEL, NOT};
