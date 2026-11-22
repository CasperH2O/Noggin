// SPDX-License-Identifier: MIT
// Noggin: the expression classifier's requests and how its answers are read: the Decisions API
// (one choice question, with a confidence) and the Responses API fallback (a JSON schema).
// The requests themselves go through lib/openai.js. Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';
const catalog = require('./catalog'), text = require('./text');
const MOODS = catalog.MOODS, moodDescription = catalog.moodDescription;

const SIZES = [{value: 'small',description: 'subtle: a look, a small nod or something on his eye'},
    {value: 'big', description: 'a whole-body move, for strong or clear feelings'}];
const SIZE_INSTRUCTIONS = 'How big should the expression be? Small for mild feelings and ordinary moments, big only when the feeling is strong or the moment is special.';
const CLASSIFIER_SYSTEM = 'You pick the body or eye expression Jibo, a small friendly social robot, performs while saying a line. ' +
    'Answer "none" for plain, factual or neutral lines; choose an expression only when the line clearly carries that feeling or moment. ' +
    'Prefer the most specific fitting expression. Also give its size: small (subtle: a look, a small nod or something on his eye) ' +
    'or big (a whole-body move, only for strong feelings or special moments). The expressions:\n' +
    Object.keys(MOODS).map(name => name + ': ' + moodDescription(name)).join('\n');
// Jibo's quick reaction the moment he has heard the person, before he answers. The
// dance (music, 6 s) is never a reaction.
const REACTION_INSTRUCTIONS = 'Jibo, a small friendly social robot, has just heard what the person said and is about to answer. ' +
    'Pick the quick expression he shows right away, the way a person reacts on their face before replying. ' +
    'Choose "none" when the words carry no particular feeling (a plain question or statement); thinking only for questions that need some thought.';
const LINE_INSTRUCTIONS = 'Pick the expression Jibo, a small friendly social robot, performs while saying this line. ' +
    'Choose "none" for plain, factual or neutral lines; choose an expression only when the line clearly carries that feeling or moment. Prefer the most specific fitting expression.';
const REACTION_SYSTEM = REACTION_INSTRUCTIONS + ' person_said is what they said; jibo_says is empty. ' +
    'Also give its size: small (subtle) or big (a whole-body move, only for strong feelings). The expressions:\n' +
    Object.keys(MOODS).filter(n => n !== 'dance').map(name => name + ': ' + moodDescription(name)).join('\n');
function choices(kind) {
    return Object.keys(MOODS).filter(n => kind !== 'reaction' || n !== 'dance')
        .map(n => ({value: n, description: moodDescription(n)}))
        .concat([{value: 'none', description: 'no particular feeling: plain, factual or neutral'}]);
}
// OpenAI's Decisions API (POST /v1/decisions, gpt-6-luna): one choice question over a
// fixed set of values, answered with a confidence.
// withSize: a second question, how big (small or big).
function decisionsRequest(model, personSaid, jiboSays, kind, withSize) {
    const reaction = kind === 'reaction';
    const questions = [{type: 'choice', name: 'expression', instructions: reaction ? REACTION_INSTRUCTIONS : LINE_INSTRUCTIONS, choices: choices(kind)}];
    if (withSize) questions.push({type: 'choice', name: 'size', instructions: SIZE_INSTRUCTIONS, choices: SIZES});
    return {
        model: model,
        input: reaction ? 'The person just said to Jibo: ' + JSON.stringify(personSaid || '')
            : 'The person said: ' + JSON.stringify(personSaid || '') + '\nJibo now says: ' + JSON.stringify(jiboSays || ''),
        questions: questions
    };
}
// {label, confidence, size}. Below `minConfidence` a real expression counts as "none". size is
// 'small', 'big' or null (not asked, or no clear answer).
function decisionLabel(body, minConfidence) {
    const answers = body && Array.isArray(body.answers) ? body.answers : [];
    const answer = answers.filter(a => a && a.name === 'expression')[0], sized = answers.filter(a => a && a.name === 'size')[0];
    const size = sized && sized.type === 'choice' && (sized.choice === 'small' || sized.choice === 'big') ? sized.choice : null;
    if (!answer || answer.type !== 'choice') return {label: null, confidence: null, size: null};
    const label = answer.choice, confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
    if (label !== 'none' && !MOODS[label]) return {label: null, confidence: confidence, size: null};
    if (label !== 'none' && confidence !== null && confidence < (minConfidence || 0)) return {label: 'none', confidence: confidence, below: label, size: null};
    return {label: label, confidence: confidence, size: label === 'none' ? null : size};
}
function classifierRequest(model, userText, jiboText, reasoning, kind) {
    const reaction = kind === 'reaction';
    const request = {
        model: model,
        input: [
            {role: 'system', content: reaction ? REACTION_SYSTEM : CLASSIFIER_SYSTEM},
            {role: 'user', content: JSON.stringify({person_said: userText || '', jibo_says: jiboText || ''})}
        ],
        text: {format: {type: 'json_schema', name: 'expression', strict: true, schema: {
            type: 'object', additionalProperties: false, required: ['expression', 'size'],
            properties: {expression: {type: 'string', enum: choices(kind).map(c => c.value)}, size: {type: 'string', enum: ['small', 'big']}}
        }}},
        max_output_tokens: 300,
        store: false
    };
    if (reasoning) request.reasoning = {effort: reasoning};
    return request;
}
// The Responses answer as {label, size}: a known mood or 'none', 'small' or 'big'; null when unreadable.
function classifierAnswer(body) {
    let answer;
    try { answer = JSON.parse(text.responseText(body)) || {}; } catch (_) { return {label: null, size: null}; }
    const label = answer.expression === 'none' || MOODS[answer.expression] ? answer.expression : null;
    const size = answer.size === 'small' || answer.size === 'big' ? answer.size : null;
    return {label: label, size: size};
}

module.exports = {choices, decisionsRequest, decisionLabel, classifierRequest, classifierAnswer};
