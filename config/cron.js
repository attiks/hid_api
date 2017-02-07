'use strict';
// config/cron.js
const https = require('https');
const async = require('async');
const _ = require('lodash');
const listAttributes = ['lists', 'operations', 'bundles', 'disasters', 'organizations', 'functional_roles'];

var deleteExpiredUsers = function (app) {
  const User = app.orm.user;
  var now = Date.now();
  var start = new Date(2016, 0, 1, 0, 0, 0);
  User.remove({expires: {$gt: start, $lt: now}});
};

var deleteExpiredTokens = function (app) {
  const OauthToken = app.orm.OauthToken;
  var now = Date.now();
  OauthToken.remove({expires: {$lt: now }});
};

var importLists = function (app) {
  const List = app.orm.list;
  const User = app.orm.user;
  const NotificationService = app.services.NotificationService;
  const listTypes = ['operation', 'bundle', 'disaster', 'organization', 'functional_role', 'office'];
  const now = Math.floor(Date.now() / 1000);
  //const Cache = app.services.CacheService.getCaches(['local-cache'])
  var hasNextPage = false, pageNumber = 1, path = '';

  // Notify users of a new disaster
  var _notifyNewDisaster = function (list) {
    if (list.metadata.operation && list.metadata.operation.length) {
      var operation = {};
      for (var i = 0, len = list.metadata.operation.length; i < len; i++) {
        operation = list.metadata.operation[i];
        List
          .findOne({remote_id: operation.id})
          .then((list) => {
            if (!list) {
              throw new Error('List not found');
            }
            return User
              .find({'operations.list': list._id})
              .then((users) => {
                return {list: list, users: users};
              });
          })
          .then((results) => {
            const list = results.list, users = results.users;
            var notification = {type: 'new_disaster', params: {list: list}};
            NotificationService.sendMultiple(users, notification, () => { });
          })
          .catch((err) => {});
      }
    }
  };

  var _createListHelper = function (list, cb) {
    List.create(list, function (err, li) {
      if (err) {
        app.log.error(err);
        return cb(err);
      }
      if (li.type === 'disaster') {
        _notifyNewDisaster(li);
      }
      cb();
    });
  };

  var _parseList = function (listType, item, cb) {
    var visibility = '', label = '', acronym = '', tmpList = {};
    visibility = 'all';
    if (item.hid_access && item.hid_access === 'closed') {
      visibility = 'verified';
    }
    label = item.label;
    if (listType === 'bundle' || listType === 'office') {
      if (item.operation[0].label) {
        label = item.operation[0].label + ': ' + item.label;
      }
      else {
        label = 'Global: ' + item.label;
      }
    }
    if (listType === 'organization' && item.acronym) {
      acronym = item.acronym;
    }
    tmpList = {
      label: label,
      acronym: acronym,
      type: listType,
      visibility: visibility,
      joinability: 'public',
      remote_id: item.id,
      metadata: item
    };
    app.log.debug('Creating list of type ' + listType + ': ' + label);
    if (listType === 'bundle') {
      List
        .findOne({type: 'operation', remote_id: item.operation[0].id})
        .then((op) => {
          if (op) {
            if (op.metadata.hid_access) {
              if (op.metadata.hid_access === 'open') {
                tmpList.visibility = 'all';
              }
              else if (op.metadata.hid_access === 'closed') {
                tmpList.visibility = 'verified';
              }
            }
          }
          cb(tmpList);
        });
    }
    else {
      cb(tmpList);
    }
  };

  // Create a list based on the item pulled from hrinfo
  var _createList = function (listType, item, cb) {
    var tmpList = {}, visibility = '', label = '', acronym = '', inactiveOps = [2782,2785,2791,38230];
    if ((listType === 'operation' && (item.status !== 'inactive' || inactiveOps.indexOf(item.id) !== -1)) || listType !== 'operation') {
      List.findOne({type: listType, remote_id: item.id}, function (err, list) {
        if (!list) {
          _parseList(listType, item, function (newList) {
            _createListHelper(newList, cb);
          });
        }
        else {
          _parseList(listType, item, function (newList) {
            var updateUsers = false;
            if (newList.name !== list.name || newList.visibility !== list.visibility) {
              updateUsers = true;
            }
            _.merge(list, newList);
            list.save().then(function (list) {
              if (updateUsers) {
                var criteria = {};
                criteria[list.type + 's.list'] = list._id.toString();
                User
                  .find(criteria)
                  .then(users => {
                    for (var i = 0; i < users.length; i++) {
                      var user = users[i];
                      for (var j = 0; j < user[list.type + 's'].length; j++) {
                        if (user[list.type + 's'][j].list === list._id) {
                          user[list.type + 's'][j].acronym = list.acronym;
                          user[list.type + 's'][j].name = list.name;
                          user[list.type + 's'][j].visibility = list.visibility;
                        }
                      }
                      user.save();
                    }
                    cb();
                  });
                }
                else {
                  cb();
                }
              });
            });
          }
        });
    }
    else {
      cb();
    }
  };

  var lastPull = 0;
  //Cache.then((mongoCache) => {
    //return mongoCache.get('lastPull', function (err, lastPull) {
      //if (err) app.log.info(err)
      if (!lastPull) {
        lastPull = 0;
      }
      // For each list type
      async.eachSeries(listTypes,
        function(listType, nextType) {
          // Parse while there are pages
          async.doWhilst(function (nextPage) {
            path = '/api/v1.0/' + listType + 's?page=' + pageNumber + '&filter[created][value]=' + lastPull + '&filter[created][operator]=>';
            if (listType === 'organization' || listType === 'functional_role') {
              path = '/api/v1.0/' + listType + 's?page=' + pageNumber;
            }
            https.get({
              host: 'www.humanitarianresponse.info',
              port: 443,
              path: path
            }, function (response) {
              pageNumber++;
              var body = '';
              response.on('data', function (d) {
                body += d;
              });
              response.on('end', function() {
                var parsed = {};
                try {
                  parsed = JSON.parse(body);
                  hasNextPage = parsed.next ? true: false;
                  async.eachSeries(parsed.data, function (item, cb) {
                    // Do not add disasters more than 2 years old
                    if (listType !== 'disaster' || (listType === 'disaster' && now - item.created < 2 * 365 * 24 * 3600)) {
                      _createList(listType, item, cb);
                    }
                    else {
                      cb();
                    }
                  }, function (err) {
                    setTimeout(function() {
                      app.log.info('Done loading page ' + pageNumber + ' for ' + listType);
                      nextPage();
                    }, 1000);
                  });
                } catch (e) {
                  app.log.error('Error parsing hrinfo API: ' + e);
                }
              });
            });
        }, function () {
          return hasNextPage;
        }, function (err, results) {
          pageNumber = 1;
          app.log.info('Done processing all ' + listType + 's');
          nextType();
        });
      }, function (err) {
        var currentTime = Math.round(Date.now() / 1000);
        // Keep item in cache 12 minutes (720 seconds)
        app.log.info(currentTime);
        /*mongoCache.set('lastPull', currentTime, {ttl: 720}, function (err) {
          app.log.info(err);
        });*/
        app.log.info('Done processing all list types');
      });
    //});
  //});
};

var sendReminderVerifyEmails = function (app) {
  const User = app.orm.User;
  const EmailService = app.services.EmailService;
  app.log.info('sending reminder emails to verify addresses');
  var stream = User.find({'email_verified': false}).stream();

  stream.on('data', function(user) {
    if (user.shouldSendReminderVerify()) {
      this.pause();

      var now = Date.now(), that = this;
      // Make sure user is not an orphan
      if (!user.createdBy) {
        EmailService.sendReminderVerify(user, function (err) {
          if (err) {
            app.log.error(err);
            that.resume();
          }
          else {
            user.remindedVerify = now.valueOf();
            user.timesRemindedVerify = user.timesRemindedVerify + 1;
            user.save();
            that.resume();
          }
        });
      }
    }
  });
};

var sendReminderUpdateEmails = function (app) {
  app.log.info('Sending reminder update emails to contacts');
  const d = new Date(),
    sixMonthsAgo = d.valueOf() - 183 * 24 * 3600 * 1000,
    User = app.orm.User,
    EmailService = app.services.EmailService;

  var stream = User.find({
    'updatedAt': { $lt: sixMonthsAgo }
  }).stream();

  stream.on('data', function(user) {
    this.pause();
    const that = this,
      now = new Date();
    if (user.shouldSendReminderUpdate()) {
      EmailService.sendReminderUpdate(user, function (err) {
        if (err) {
          app.log.error(err);
        }
        else {
          user.remindedUpdate = now;
          user.save();
        }
        that.resume();
      });
    }
  });
};

var sendReminderCheckoutEmails = function(app) {
  app.log.info('Sending reminder checkout emails to contacts');
  const User = app.orm.User,
    NotificationService = app.services.NotificationService;
  var populate = '';
  var criteria = {};
  criteria.email_verified = true;
  criteria.$or = [];
  listAttributes.forEach(function (attr) {
    var remindedAttr = attr + '.remindedCheckout';
    criteria.$or.push({remindedAttr: false});
    populate += ' ' + attr + '.list';
  });

  var stream = User
    .find(criteria)
    .populate(populate)
    .cursor();

  stream.on('data', function(user) {
    let that = this;
    let now = Date.now();
    listAttributes.forEach(function (attr) {
      for (var i = 0; i < user[attr].length; i++) {
        var lu = user[attr][i];
        if (this.checkoutDate && this.remindedCheckout === false) {
          var dep = new Date(this.checkoutDate);
          if (now.valueOf() - dep.valueOf() > 48 * 3600 * 1000) {
            that.pause();
            var notification = {type: 'reminder_checkout', user: user, params: {listUser: lu, list: lu.list}};
            NotificationService.send(notification, () => {
              lu.remindedCheckout = true;
              user.save();
              that.resume();
            });
          }
        }
      }
    });
  });
};

var doAutomatedCheckout = function(app) {
  app.log.info('Running automated checkouts');
  const User = app.orm.User,
    NotificationService = app.services.NotificationService;

  var populate = '';
  var criteria = {};
  criteria.email_verified = true;
  criteria.$or = [];
  listAttributes.forEach(function (attr) {
    var remindedAttr = attr + '.remindedCheckout';
    criteria.$or.push({remindedAttr: true});
    populate += ' ' + attr + '.list';
  });

  var stream = User
    .find(criteria)
    .populate(populate)
    .cursor();

  stream.on('data', function(user) {
    let that = this;
    let now = Date.now();
    listAttributes.forEach(function (attr) {
      for (var i = 0; i < user[attr].length; i++) {
        var lu = user[attr][i];
        if (this.checkoutDate && this.remindedCheckout === true) {
          var dep = new Date(this.checkoutDate);
          if (now.valueOf() - dep.valueOf() > 14 * 24 * 3600 * 1000) {
            that.pause();
            var notification = {type: 'automated_checkout', user: user, params: {listUser: lu, list: lu.list}};
            NotificationService.send(notification, () => {
              lu.deleted = true;
              user.save();
              that.resume();
            });
          }
        }
      }
    });
  });
};

var sendReminderCheckinEmails = function(app) {
  app.log.info('Sending reminder checkin emails to contacts');
  const User = app.orm.User,
    NotificationService = app.services.NotificationService;

  var stream = User
    .find({'operations.remindedCheckin': false })
    .populate('operations.list')
    .cursor();

  stream.on('data', function(user) {
    this.pause();
    var that = this;
    for (var i = 0; i < user.operations.length; i++) {
      var lu = user.operations[i];
      var d = new Date(),
        createdAt = new Date(lu.createdAt),
        offset = d.valueOf() - lu.valueOf();

      if (!lu.remindedCheckin && offset > 48 * 3600 * 1000 && offset < 72 * 3600 * 1000) {
        var hasLocalPhoneNumber = user.hasLocalPhoneNumber(lu.list.metadata.country.pcode);
        user.isInCountry(lu.list.metadata.country.pcode, function (err, inCountry) {
          var notification = {
            type: 'reminder_checkin',
            user: user,
            params: {listUser: lu, list: lu.list, hasLocalPhoneNumber: hasLocalPhoneNumber, inCountry: inCountry}
          };
          NotificationService.send(notification, () => {
            lu.remindedCheckin = true;
            user.save();
          });
        });
      }
    }
    that.resume();
  });
};

module.exports = {
  importLists: importLists,
  jobs: {
    // Delete expired users
    deleteExpiredUsers: {
      schedule: '1 * * * *',
      onTick: deleteExpiredUsers,
      start: true
    },
    // Delete expired oauth tokens
    deleteExpiredTokens: {
      schedule: '1 * * * *',
      onTick: deleteExpiredTokens,
      start: true
    },
    // Import lists from Humanitarianresponse
    /*importLists: {
      schedule: '1 * * * *', // Run every 60 minutes
      onTick: importLists,
      start: true
    },*/
    // Remind users to verify their email
    sendReminderVerifyEmails: {
      schedule: '1 * * * *',
      onTick: sendReminderVerifyEmails,
      start: true
    },
    // Send a reminder to people who haven't updated their profile in the last 6 months
    sendReminderUpdateEmails: {
      schedule: '1 * * * *',
      onTick: sendReminderUpdateEmails,
      start: true
    },
    // Send a reminder to checkout to people who are 2 days past their checkout date
    sendReminderCheckoutEmails: {
      schedule: '1 * * * *',
      onTick: sendReminderCheckoutEmails,
      start: true
    },
    // Do the automated to checkout to people who are 14 days past their checkout date
    doAutomatedCheckout: {
      schedule: '1 * * * *',
      onTick: doAutomatedCheckout,
      start: true
    },
    // Reminder emails sent out 48 hours after checkin to remind people to add a local phone number if they didn't do so
    sendReminderCheckinEmails: {
      schedule: '1 * * * *',
      onTick: sendReminderCheckinEmails,
      start: true
    }
  }
};
