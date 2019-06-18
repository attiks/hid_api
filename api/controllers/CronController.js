

/* eslint no-await-in-loop: "off", no-restricted-syntax: "off" */
const listAttributes = [
  'lists',
  'operations',
  'bundles',
  'disasters',
  'organizations',
  'functional_roles',
];
const hidAccount = '5b2128e754a0d6046d6c69f2';
const cp = require('child_process');
const OauthToken = require('../models/OauthToken');
const User = require('../models/User');
const EmailService = require('../services/EmailService');
const NotificationService = require('../services/NotificationService');
const ListUserController = require('./ListUserController');
const config = require('../../config/env')[process.env.NODE_ENV];

const { logger } = config;

/**
 * @module CronController
 * @description Generated Trails.js Controller.
 */
module.exports = {

  async deleteExpiredUsers(request, reply) {
    const now = new Date();
    const start = new Date(2016, 0, 1, 0, 0, 0);
    const users = await User.find({ expires: { $gt: start, $lt: now } });
    if (users.length > 0) {
      const hidUser = await User.findOne({ _id: hidAccount });
      const promises = [];
      users.forEach((user) => {
        promises.push(EmailService.sendAdminDelete(user, hidUser));
      });
      await Promise.all(promises);
      await User.remove({ expires: { $gt: start, $lt: now } });
    }
    return reply.response().code(204);
  },

  async deleteExpiredTokens(request, reply) {
    logger.info('Deleting expired Oauth Tokens');
    const now = new Date();
    await OauthToken.remove({ expires: { $lt: now } });
    return reply.response().code(204);
  },

  async sendReminderUpdateEmails(request, reply) {
    logger.info('Sending reminder update emails to contacts');
    const d = new Date();
    const sixMonthsAgo = d.valueOf() - 183 * 24 * 3600 * 1000;

    const cursor = User.find({
      lastModified: { $lt: sixMonthsAgo },
      authOnly: false,
    }).cursor();

    const promises = [];
    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      if (user.shouldSendReminderUpdate()) {
        promises.push(EmailService.sendReminderUpdate(user));
        promises.push(User.collection.update(
          { _id: user._id },
          {
            $set: {
              remindedUpdate: new Date(),
            },
          },
        ));
      }
    }
    await Promise.all(promises);
    return reply.response().code(204);
  },

  // Send reminder checkout email 48 hours before
  // the departure date
  async sendReminderCheckoutEmails(request, reply) {
    logger.info('Sending reminder checkout emails to contacts');
    const now = new Date();
    let populate = '';
    const criteria = {};
    criteria.email_verified = true;
    criteria.$or = [];
    listAttributes.forEach((attr) => {
      const tmp = {};
      tmp[`${attr}.remindedCheckout`] = false;
      criteria.$or.push(tmp);
      populate += ` ${attr}.list`;
    });

    const response = reply.response().code(204);
    const cursor = User.find(criteria).populate(populate).cursor({ noCursorTimeout: true });

    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      for (const listAttribute of listAttributes) {
        for (const lu of user[listAttribute]) {
          try {
            if (lu.checkoutDate && lu.remindedCheckout === false && !lu.deleted) {
              const dep = new Date(lu.checkoutDate);
              if (dep.valueOf() - now.valueOf() < 48 * 3600 * 1000) {
                const notification = { type: 'reminder_checkout', user, params: { listUser: lu, list: lu.list } };
                await NotificationService.send(notification);
                lu.remindedCheckout = true;
                await user.save();
              }
            }
          } catch (err) {
            logger.error(err);
          }
        }
      }
    }
    logger.info('Finished sending reminder checkout emails');

    return promise;
  },

  // Automatically check user out maximum 24 hours after his departure date
  async doAutomatedCheckout(request, reply) {
    logger.info('Running automated checkouts');
    let populate = '';
    const criteria = {};
    criteria.email_verified = true;
    criteria.$or = [];
    listAttributes.forEach((attr) => {
      const tmp = {};
      tmp[`${attr}.remindedCheckout`] = true;
      criteria.$or.push(tmp);
      populate += ` ${attr}.list`;
    });

    const now = Date.now();
    const cursor = User.find(criteria).populate(populate).cursor({ noCursorTimeout: true });

    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      for (const listAttribute of listAttributes) {
        for (const lu of user[listAttribute]) {
          try {
            if (lu.checkoutDate && lu.remindedCheckout === true && !lu.deleted) {
              const dep = new Date(lu.checkoutDate);
              if (now.valueOf() - dep.valueOf() > 24 * 3600 * 1000) {
                lu.deleted = true;
                await user.save();
              }
            }
          } catch (err) {
            logger.error(err);
          }
        }
      }
    }
    return reply.response().code(204);
  },

  async sendReminderCheckinEmails(request, reply) {
    logger.info('Sending reminder checkin emails to contacts');

    const response = reply.response().code(204);
    const cursor = User
      .find({ 'operations.remindedCheckin': false })
      .populate('operations.list')
      .cursor({ noCursorTimeout: true });

    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      for (const lu of user.operations) {
        const d = new Date();
        const offset = d.valueOf() - lu.valueOf();

        if (!lu.remindedCheckin && offset > 48 * 3600 * 1000
          && offset < 72 * 3600 * 1000
          && !lu.deleted) {
          const hasLocalPhoneNumber = user.hasLocalPhoneNumber(lu.list.metadata.country.pcode);
          const inCountry = await user.isInCountry(lu.list.metadata.country.pcode);
          const notification = {
            type: 'reminder_checkin',
            user,
            params: {
              listUser: lu, list: lu.list, hasLocalPhoneNumber, inCountry,
            },
          };
          await NotificationService.send(notification);
          lu.remindedCheckin = true;
          await user.save();
        }
      }
    }
    logger.info('Finished sending reminder checkin emails');
    return reply.response().code(204);
  },

  async forcedResetPasswordAlert(request, reply) {
    try {
      const current = Date.now();
      const fiveMonths = new Date(current - 5 * 30 * 24 * 3600 * 1000);
      const cursor = User.find({
        totp: false,
        passwordResetAlert30days: false,
        $or: [{ lastPasswordReset: { $lte: fiveMonths } }, { lastPasswordReset: null }],
      }).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        if (user.email) {
          await EmailService.sendForcedPasswordResetAlert(user);
          await User.collection.updateOne(
            { _id: user._id },
            {
              $set: {
                passwordResetAlert30days: true,
              },
            },
          );
        }
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  async forcedResetPasswordAlert7(request, reply) {
    try {
      const current = Date.now();
      const fiveMonthsAnd23Days = new Date(current - 173 * 24 * 3600 * 1000);
      const cursor = User.find({
        totp: false,
        passwordResetAlert7days: false,
        $or: [{ lastPasswordReset: { $lte: fiveMonthsAnd23Days } }, { lastPasswordReset: null }],
      }).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        if (user.email) {
          await EmailService.sendForcedPasswordResetAlert7(user);
          await User.collection.updateOne(
            { _id: user._id },
            {
              $set: {
                passwordResetAlert7days: true,
              },
            },
          );
        }
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  async forceResetPassword(request, reply) {
    try {
      const current = Date.now();
      const sixMonths = new Date(current - 6 * 30 * 24 * 3600 * 1000);
      const cursor = User.find({
        totp: false,
        passwordResetAlert: false,
        $or: [{ lastPasswordReset: { $lte: sixMonths } }, { lastPasswordReset: null }],
      }).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        if (user.email) {
          await EmailService.sendForcedPasswordReset(user);
          await User.collection.updateOne(
            { _id: user._id },
            {
              $set: {
                passwordResetAlert: true,
              },
            },
          );
        }
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  async sendSpecialPasswordResetEmail(request, reply) {
    const cursor = User.find({ deleted: false }).cursor();

    for (let user = await cursor.next(); user != null; user = await cursor.next()) {
      await EmailService.sendSpecialPasswordReset(user);
    }
    return reply.response().code(204);
  },

  async setListCounts(request, reply) {
    cp.fork('api/workers');
    return reply.response().code(204);
  },

  /* adjustEmailVerified (request, reply) {
    const app = this.app;
    const stream = User.find({'email_verified': false}).cursor();

    stream.on('data', function(user) {
      const sthat = this;
      this.pause();
      let index = user.emailIndex(user.email);
      if (index !== -1 && user.emails[index].validated === true) {
        user.email_verified = true;
        user.save(function (err) {
          sthat.resume();
        });
      }
      else {
        this.resume();
      }
    });

    stream.on('end', function () {
      reply().code(204);
    });
  }

  adjustEmailDuplicates (request, reply) {
    const app = this.app;
    const stream = User.find({}).cursor();

    stream.on('data', function(user) {
      const sthat = this;
      this.pause();
      let count = 0, ids = [];
      user.emails.forEach(function (email) {
        if (email.email === user.email) {
          count++;
          if (count > 1 && email.validated === false) {
            ids.push(email._id);
          }
        }
      });
      if (ids.length) {
        ids.forEach(function (id) {
          user.emails.id(id).remove();
        });
        user.save(function (err) {
          sthat.resume();
        });
      }
      else {
        this.resume();
      }
    });

    stream.on('end', function () {
      reply().code(204);
    });
  } */

  async verifyAutomatically(request, reply) {
    try {
      logger.info('automatically verify users');
      const cursor = User.find({}).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        const promises = [];
        user.emails.forEach((email) => {
          if (email.validated) {
            promises.push(user.isVerifiableEmail(email.email));
          }
        });
        const domains = await Promise.all(promises);
        for (const domain in domains) {
          if (domain) {
            user.verified = true;
            user.verified_by = hidAccount;
            if (!user.verified) {
              user.verifiedOn = new Date();
            }
            // If the domain is associated to a list, check user in this list automatically
            if (domain.list) {
              if (!user.organizations) {
                user.organizations = [];
              }

              let isCheckedIn = false;
              // Make sure user is not already checked in this list
              for (let i = 0, len = user.organizations.length; i < len; i += 1) {
                if (user.organizations[i].list.equals(domain.list._id)
                  && user.organizations[i].deleted === false) {
                  isCheckedIn = true;
                }
              }

              if (!isCheckedIn) {
                await ListUserController.checkinHelper(domain.list, user, true, 'organizations', user);
              }
            }
            await user.save();
          }
        }
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  async verificationExpiryEmail(request, reply) {
    try {
      const current = Date.now();
      const oneYear = new Date(current - 358 * 24 * 3600 * 1000);
      const cursor = User.find({
        verified: true,
        verifiedOn: { $lte: oneYear },
        verified_by: { $ne: hidAccount },
        verificationExpiryEmail: false,
      }).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        if (user.email) {
          await EmailService.sendVerificationExpiryEmail(user);
          await User.collection.update(
            { _id: user._id },
            {
              $set: {
                verificationExpiryEmail: true,
              },
            },
          );
        }
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  async unverifyAfterOneYear(request, reply) {
    try {
      const current = Date.now();
      const oneYear = new Date(current - 365 * 24 * 3600 * 1000);
      const cursor = User.find({
        verified: true,
        verifiedOn: { $lte: oneYear },
        verificationExpiryEmail: true,
        verified_by: { $ne: hidAccount },
      }).cursor({ noCursorTimeout: true });

      for (let user = await cursor.next(); user != null; user = await cursor.next()) {
        await User.collection.update(
          { _id: user._id },
          {
            $set: {
              verified: false,
              verifiedOn: new Date(0, 0, 1, 0, 0, 0),
              verified_by: null,
            },
          },
        );
      }
    } catch (err) {
      logger.error(err);
    }
    return reply.response().code(204);
  },

  /* verifyEmails: function (request, reply) {
    const stream = User.find({email_verified: false}).cursor();
    stream.on('data', function (user) {
      const sthat = this;
      this.pause();
      https.get('https://app.verify-email.org/api/v1/' + process.env.VERIFY_EMAILS_KEY + '/verify/' + user.email, (res) => {
        let body = '';
        res.on('data', function (d) {
          body += d;
        });
        res.on('end', function() {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
            if (parsed.status === 1) {
              user.verifyEmail(user.email);
              user.save(function (err) {
                sthat.resume();
              });
            }
            else {
              sthat.resume();
            }
          }
          catch (err) {
            sthat.resume();
          }
        });
      });
    });
  },

  setAcronymsOrNames: function (request, reply) {
    reply().code(204);
    const stream = User.find({}).cursor();
    stream.on('data', function (user) {
      if (user.organization) {
        user.organization.acronymsOrNames = {};
        user.organization.names.forEach(function (name) {
          user.organization.acronymsOrNames[name.language] = name.text;
        });
        user.organization.acronyms.forEach(function (acronym) {
          if (acronym.text !== '') {
            user.organization.acronymsOrNames[acronym.language] = acronym.text;
          }
        });
        user.save();
      }
    });
  } */

};
