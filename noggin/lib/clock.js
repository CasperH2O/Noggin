// SPDX-License-Identifier: MIT
// Noggin: time where Jibo lives. Local time in his home timezone, how it is said ("7:30 PM",
// "Thursday, November 12, 2026", "1 hour and 30 minutes"), and @be/clock's timer and alarm read
// from its record. Node 6 / Chrome 53: ES2015 only.
'use strict';
const withTimeout = require('./timing').withTimeout, strings = require('./text');

// "1 hour and 30 minutes"
function duration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600), m = Math.floor(totalSeconds % 3600 / 60), s = Math.round(totalSeconds % 60);
    const parts = [];
    if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (s || !parts.length) parts.push(s + (s === 1 ? ' second' : ' seconds'));
    return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
}
// An hour (0-23) and minute on the 12-hour clock: {time: "7:30", ampm: "PM"}.
function twelveHour(hour, minute) {
    return {time: ((hour % 12) || 12) + ':' + strings.pad2(minute), ampm: hour < 12 ? 'AM' : 'PM'};
}

// Local time where Jibo lives, as @be/clock tells it: jibo.utils.DateTime in the home
// timezone (the robot's system clock may run on UTC). Falls back to the system's local time.
function localTime(jibo, ms) {
    ms = ms === undefined ? Date.now() : ms;
    try {
        const utils = jibo && jibo.utils, home = utils && utils.Location && utils.Location.jiboHome, zone = home && home.timezone;
        if (utils && utils.DateTime && zone) {
            const t = new utils.DateTime(ms, zone).getLocalTime();
            if (t && typeof t.hour === 'number' && typeof t.minute === 'number' && typeof t.monthNum === 'number')
                return {year: t.year, monthNum: t.monthNum, date: t.date, dayOfWeek: t.dayOfWeek || null, hour: t.hour, minute: t.minute, zone: zone.id || null};
        }
    } catch (_) {}
    return strings.systemTime(ms);
}
// Date or localTime() -> {time: "7:30 PM", date: "Thursday, November 12, 2026", timezone}
function describeTime(t) {
    if (t && typeof t.getDay === 'function') t = strings.systemTime(t.getTime());
    const at = twelveHour(t.hour, t.minute);
    // Jibo's DateTime gives the weekday in lower case ("sunday").
    const named = t.dayOfWeek || strings.DAYS[new Date(t.year, t.monthNum, t.date).getDay()];
    const day = named.charAt(0).toUpperCase() + named.slice(1);
    return {time: at.time + ' ' + at.ampm, date: day + ', ' + strings.MONTHS[t.monthNum] + ' ' + t.date + ', ' + t.year, timezone: t.zone || null};
}

// @be/clock's record in the knowledge base (read-only): its `data`, or null if it can't be read in time.
function clockRecord(jibo, timeoutMs) {
    const kb = jibo && jibo.kb;
    if (!kb || typeof kb.createModel !== 'function') return Promise.resolve(null);
    const read = Promise.resolve().then(() => kb.onInit ? kb.onInit() : null)
        .then(() => kb.createModel('/jibo/clock/alarm_timer').loadRoot())
        .then(root => root && root.data || {});
    return withTimeout(read, timeoutMs || 2000, () => null).catch(() => null);
}
function timerState(data, at) {
    const timer = data.timer;
    if (!timer || typeof timer.endTime !== 'number' || timer.endTime <= at) return {set: false};
    const left = Math.round((timer.endTime - at) / 1000);
    return {set: true, remaining_s: left, remaining: duration(left), length_s: typeof timer.length === 'number' ? Math.round(timer.length / 1000) : null};
}
// The alarm keeps its time as a serialised DateTime; `utc` is the moment it goes off.
function alarmState(jibo, data, at) {
    const alarm = data.alarm, when = alarm && alarm.dateTimeInstance && alarm.dateTimeInstance.utc;
    if (typeof when !== 'number' || when <= at) return {set: false};
    const t = describeTime(localTime(jibo, when));
    return {set: true, time: t.time, day: t.date};
}
// The timer and the alarm: {timer, alarm}, or null if the record can't be read.
function readClock(jibo, now, timeoutMs) {
    return clockRecord(jibo, timeoutMs).then(data => {
        if (!data) return null;
        const at = now ? now() : Date.now();
        return {timer: timerState(data, at), alarm: alarmState(jibo, data, at)};
    });
}

module.exports = {duration, twelveHour, localTime, describeTime, readClock};
