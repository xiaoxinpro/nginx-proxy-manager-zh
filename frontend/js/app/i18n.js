const Cache    = ('./cache');
const messages = require('../i18n/messages.json');

/**
 * @param {String}  namespace
 * @param {String}  key
 * @param {Object}  [data]
 */
module.exports = function (namespace, key, data) {
    let locale = Cache.locale;
    // check that the locale exists
    if (typeof messages[locale] === 'undefined') {
        locale = 'zh';
    }

    if (typeof messages[locale][namespace] !== 'undefined' && typeof messages[locale][namespace][key] !== 'undefined') {
        return messages[locale][namespace][key](data);
    } else if (locale !== 'zh' && typeof messages['zh'][namespace] !== 'undefined' && typeof messages['zh'][namespace][key] !== 'undefined') {
        return messages['zh'][namespace][key](data);
    }

    return '(MISSING: ' + namespace + '/' + key + ')';
};
