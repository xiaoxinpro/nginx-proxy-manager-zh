const UserModel = require('../models/user');

let cache = {
    User:    new UserModel.Model(),
    locale:  'zh',
    version: null
};

module.exports = cache;

