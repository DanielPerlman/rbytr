'use strict';

/**
 * Module dependencies.
 */
var path = require('path'),
  config = require(path.resolve('./config/config')),
  errorHandler = require(path.resolve('./modules/core/server/controllers/errors.server.controller')), 
  mongoose = require('mongoose'), 
  passport = require('passport'),
  User = mongoose.model('User'),
  nodemailer = require('nodemailer'),
  async = require('async'),
  crypto = require('crypto');

// URLs for which user can't be redirected on signin
var noReturnUrls = [ '/authentication/signin', '/authentication/signup' ];

// smtp transport
var smtpTransport = nodemailer.createTransport(config.mailer.options);


/**
 * Signup
 */
exports.signup = function(req, res) {
  var rbytrId = '576530cbac09993c1fb7e307'; // live
//  var rbytrId = '577bc933ed847e1307b95874'; // local
  User.findById(rbytrId).exec(function (err, rbytrUser) {
    if (err) {
      return res.status(400).send({
        message : errorHandler.getErrorMessage(err)
      });
    } else if (!rbytrUser) {
      return res.status(404).send({
        message: 'No user with that identifier has been found'
      });
    }

    // For security measurement we remove the roles from the req.body object
    delete req.body.roles;
  
    // Init Variables
    var user = new User(req.body);
    var message = null;
  
    // Add missing user fields
    user.provider = 'local';
    user.displayName = user.firstName + ' ' + user.lastName;
    user.following.push(rbytrUser._id);
    user.followedBy.push(rbytrUser._id);
    
    // Then save the user
    user.save(function(err) {
      if (err) {
        return res.status(400).send({
          message : errorHandler.getErrorMessage(err)
        });
      } else {
        // Remove sensitive data before login
        user.password = undefined;
        user.salt = undefined;
        // rbytr following and followedBy new user:
        rbytrUser.following.push(user._id);
        rbytrUser.followedBy.push(user._id);
        
        rbytrUser.save(function (err) {
          if (err) {
            return res.status(400).send({
              message : errorHandler.getErrorMessage(err)
            });
          } else {
            req.login(user, function(err) {
              if (err) {
                res.status(400).send(err);
              } else {
                res.json(user);
              }
            });
          }
        });
      }
    });
  });
};

/**
 * Signin after passport authentication
 */
exports.signin = function(req, res, next) {
  passport.authenticate('local', function(err, user, info) {
    if (err || !user) {
      res.status(400).send(info);
    } else {
      // Remove sensitive data before login
      user.password = undefined;
      user.salt = undefined;

      req.login(user, function(err) {
        if (err) {
          res.status(400).send(err);
        } else {
          res.json(user);
        }
      });
    }
  })(req, res, next);
};

/**
 * Signout
 */
exports.signout = function(req, res) {
  req.logout();
  res.redirect('/');
};

/**
 * OAuth provider call
 */
exports.oauthCall = function(strategy, scope) {
  return function(req, res, next) {
    // Set redirection path on session.
    // Do not redirect to a signin or signup page
    if (noReturnUrls.indexOf(req.query.redirect_to) === -1) {
      req.session.redirect_to = req.query.redirect_to;
    }
    // Authenticate
    passport.authenticate(strategy, scope)(req, res, next);
  };
};

/**
 * OAuth callback
 */
exports.oauthCallback = function(strategy) {
  return function(req, res, next) {
    // Pop redirect URL from session
    var sessionRedirectURL = req.session.redirect_to;
    delete req.session.redirect_to;

    passport.authenticate(strategy, function(err, user, redirectURL) {
      if (err) {
        return res.redirect('/authentication/signin?err=' + encodeURIComponent(errorHandler.getErrorMessage(err)));
      }
      if (!user) {
        return res.redirect('/authentication/signin');
      }
      req.login(user, function(err) {
        if (err) {
          return res.redirect('/authentication/signin');
        }
        // return res.redirect(redirectURL || sessionRedirectURL || '/');
        return res.redirect(sessionRedirectURL || '/');
      });
    })(req, res, next);
  };
};

/**
 * Helper function to save or update a OAuth user profile
 */
exports.saveOAuthUserProfile = function(req, providerUserProfile, done) {
  if (!req.user) {
    // Define a search query fields
    var searchMainProviderIdentifierField = 'providerData.'
        + providerUserProfile.providerIdentifierField;
    var searchAdditionalProviderIdentifierField = 'additionalProvidersData.'
        + providerUserProfile.provider + '.'
        + providerUserProfile.providerIdentifierField;

    // Define main provider search query
    var mainProviderSearchQuery = {};
    mainProviderSearchQuery.provider = providerUserProfile.provider;
    mainProviderSearchQuery[searchMainProviderIdentifierField] = providerUserProfile.providerData[providerUserProfile.providerIdentifierField];
    // mainProviderSearchQuery[searchMainProviderIdentifierField] =
    // providerUserProfile.providerId;

    // Define additional provider search query
    var additionalProviderSearchQuery = {};
    additionalProviderSearchQuery[searchAdditionalProviderIdentifierField] = providerUserProfile.providerData[providerUserProfile.providerIdentifierField];
    // additionalProviderSearchQuery[searchAdditionalProviderIdentifierField] =
    // providerUserProfile.providerId;

    // Define a search query to find existing user with current provider profile
    var searchQuery = {
      $or : [ mainProviderSearchQuery, additionalProviderSearchQuery ]
    };
    User.findOne(searchQuery, function(err, user) {
      if (err) {
        return done(err);
      } else {
        if (!user) {
          var possibleUsername = providerUserProfile.username
              || ((providerUserProfile.email) ? providerUserProfile.email
                  .split('@')[0] : '');

          User.findUniqueUsername(possibleUsername, null, function(
              availableUsername) {
            user = new User({
              firstName : providerUserProfile.firstName,
              lastName : providerUserProfile.lastName,
              username : availableUsername,
              displayName : providerUserProfile.displayName,
              email : providerUserProfile.email,
              profileImageURL : providerUserProfile.profileImageURL,
              provider : providerUserProfile.provider,
              providerData : providerUserProfile.providerData
            });

            // And save the user
            user.save(function(err) {
              return done(err, user);
            });
          });
        } else {
          return done(err, user);
        }
      }
    });
  } else {
    // User is already logged in, join the provider data to the existing user
    var user = req.user;
    
    // Check if user exists, is not signed in using this provider, and doesn't
    // have that provider data already configured
    if (user.provider !== providerUserProfile.provider
        && (!user.additionalProvidersData || !user.additionalProvidersData[providerUserProfile.provider])) {
      // Add the provider data to the additional provider data field
      if (!user.additionalProvidersData) {
        user.additionalProvidersData = {};
      }

      user.additionalProvidersData[providerUserProfile.provider] = providerUserProfile.providerData;

      // replace profileImageURL by image from this provider
      // user.profileImageURL = providerUserProfile.profileImageURL;

      // replace email by email from this provider
      if (providerUserProfile.hasOwnProperty('email')) {
        if (providerUserProfile.email !== 'undefined') {
          user.email = providerUserProfile.email;
        }
      }

      // Then tell mongoose that we've updated the additionalProvidersData field
      user.markModified('additionalProvidersData');

      // And save the user
      user.save(function(err) {
        return done(err, user, '/settings/accounts');
      });
    } else {
      return done(new Error('User is already connected using this provider'),
          user);
    }
  }
};

/**
 * Remove OAuth provider
 */
exports.removeOAuthProvider = function(req, res, next) {
  var user = req.user;
  var provider = req.query.provider;

  if (!user) {
    return res.status(401).json({
      message : 'User is not authenticated'
    });
  } else if (!provider) {
    return res.status(400).send();
  }

  // Delete the additional provider
  if (user.additionalProvidersData[provider]) {
    delete user.additionalProvidersData[provider];

    // Then tell mongoose that we've updated the additionalProvidersData field
    user.markModified('additionalProvidersData');
  }

  user.save(function(err) {
    if (err) {
      return res.status(400).send({
        message : errorHandler.getErrorMessage(err)
      });
    } else {
      req.login(user, function(err) {
        if (err) {
          return res.status(400).send(err);
        } else {
          return res.json(user);
        }
      });
    }
  });
};

/**
 * Request invite
 * 
 * A new user can ask for an invite or get invited by an approved user
 * A new user object will be created with the provided email address
 * An email will be sent to the email address
 * If there has been an inviter, the inviter follows the new user and vice versa
 * 
 * requestInvite calls sendEmail(req, res, user[, req.user]):
 * @param {object} req 
 * @param {object} res 
 * @param {object} user - the unapproved user
 * @param {object} req.user - the optional inviting user
 */
exports.requestInvite = function (req, res, next) {
  // For security measurement we remove the roles from the req.body object
  delete req.body.roles;

  // Init Variables
  var user;
  var message = null;
  
  // check if someone with "req.body.email" already asked for an invite
  User.findOne({
    email: req.body.email
  }, function (err, response) {
    if (err) {
      console.log(err);
    }
    if (!response) {
      user = new User(req.body);
    } else {
      user = response;
    }
    
    
    // Add missing user fields
    user.provider = 'local';
    user.username = req.body.email;
    user.firstName = '';
    user.lastName = '';
    
    // user gets invited by approved user
    if (req.user) {
      user.approved = true;
      user.following.push(req.user._id);
      user.followedBy.push(req.user._id);
    }
    
    user.save(function(err) {
      if (err) {
        console.log(err);
      }
      if (req.user) {
        exports.sendEmail(req, res, user, req.user, function (err, response) {
          if (err) {
            return res.status(400).send(err);
          } else {
            // inviter follows new user
            var inviter = req.user;
            inviter.following.push(user._id);
            inviter.followedBy.push(user._id);
            
            // blocking?
            inviter.save();
            return res.status(200).send(err);
          }
        });
      } else {
        exports.sendEmail(req, res, user, null, function (err, response) {
          if (err) {
            return res.status(400).send(err);
          } else {
            return res.status(200).send(err);
          }
        });
      }
    });
  });
};

/**
 * Send email
 * 
 * Send email to user
 * @param {object} req 
 * @param {object} res
 * @param {object} user - the unapproved user
 * @param {object} inviter - an optional object, approved user who invites the user
 * @param {Function} [callback] - A callback which is called as soon as the email got sent, 
 * or an error occurs. Invoked with
 * (err, response)
 */
exports.sendEmail = function (req, res, user, inviter, callback) {
  async.waterfall([
    // Generate random token
    function (done) {
      crypto.randomBytes(20, function (err, buffer) {
        var token = buffer.toString('hex');
        done(err, token);
      });
    },
    // Save invite token
    function (token, done) {
      if (inviter) {
        user.inviteToken = token;
        user.inviteTokenExpires = Date.now() + 3600000*24*7; // 1 week
        user.save(function (err) {
          done(err, token, user);
        });
      } else {
        done(null, token, user);
      }
    },
    // create email string either for invitation or self-invite
    function (token, user, done) {
      var httpTransport = 'http://';
      if (config.secure && config.secure.ssl === true) {
        httpTransport = 'https://';
      }
      if (inviter) {
        res.render(path.resolve('modules/users/server/templates/invite-email'), {
          inviter: inviter.displayName,
          appName: config.app.title,
          url: httpTransport + req.headers.host + '/api/auth/invite/' + token,
          inviteTokenExpires: user.inviteTokenExpires.toString()
        }, function (err, emailHTML) {
          done(err, emailHTML, user);
        });
      } else {
        res.render(path.resolve('modules/users/server/templates/self-invite-email'), {
          appName: config.app.title
        }, function (err, emailHTML) {
          done(err, emailHTML, user);
        });
      }
    },
    // If valid email, send invite email using service
    function (emailHTML, user, done) {
      var mailOptions = {
        to: user.email,
        from: config.mailer.from,
        subject: 'Invite',
        html: emailHTML
      };
      smtpTransport.sendMail(mailOptions, function (err) {
        if (err) {
          done(err);
        }
        done(err, user);
      });
    },
    // prepare email for rbytr
    function (user, done) {
      if (typeof inviter === 'undefined' || 'null') {
        inviter = {};
        inviter.displayName = '';
        inviter._id = '';
      }
      res.render(path.resolve('modules/users/server/templates/notice-email'), {
        inviterName: inviter.displayName,
        inviterId: inviter._id,
        userEmail: user.email
      }, function (err, emailHTML) {
        done(err, emailHTML, user);
      });
    },
    // send email for rbytr
    function (emailHTML, user, done) {
      var mailOptions = {
        to: config.mailer.from,
        from: config.mailer.from,
        subject: 'Invite',
        html: emailHTML
      };
      smtpTransport.sendMail(mailOptions, function (err) {
        if (err) {
          callback(err);
        }
        callback(null);
      });
    }
  ]);
};

/**
 * Invite GET from email token
 */
exports.validateInviteToken = function (req, res) {
  User.findOne({
    inviteToken: req.params.token,
    inviteTokenExpires: {
      $gt: Date.now()
    }
  }, function (err, user) {
    if (!user) {
      return res.redirect('/authentication/invited/invalid');
    }

    res.redirect('/authentication/invited/' + req.params.token);
  });
};

/**
 * Invite authentication POST from email token
 * To be adjusted !!!
 */
exports.invited = function (req, res, next) {
  // Init Variables
  var authDetails = req.body;
  var message = null;
  
  async.waterfall([

    function (done) {
      User.findOne({
        inviteToken: req.params.token,
        inviteTokenExpires: {
          $gt: Date.now()
        }
      }, function (err, user) {
        if (!err && user) {
          /*find rbytr*/
          var rbytrId = '576530cbac09993c1fb7e307'; // live
//          var rbytrId = '577bc933ed847e1307b95874'; // local
          User.findById(rbytrId).exec(function (err, rbytrUser) {
            if (err) {
              return res.status(400).send({
                message : errorHandler.getErrorMessage(err)
              });
            } else if (!rbytrUser) {
              return res.status(404).send({
                message: 'No user with that identifier has been found'
              });
            }
            /* and follow rbytr */
          
            // Add missing user fields
            user.provider = 'local';
            user.firstName = authDetails.firstName;
            user.lastName = authDetails.lastName;
            user.displayName = authDetails.firstName + ' ' + authDetails.lastName;
            user.email = authDetails.email;
            user.username = authDetails.username;
            user.password = authDetails.password;
            user.following.push(rbytrUser._id);
            user.followedBy.push(rbytrUser._id);
            user.inviteToken = undefined;
            user.inviteTokenExpires = undefined;
  
            user.save(function (err) {
              if (err) {
                return res.status(400).send({
                  message: errorHandler.getErrorMessage(err)
                });
              } else {
                req.login(user, function (err) {
                  if (err) {
                    res.status(400).send(err);
                  } else {
                    // Remove sensitive data before return authenticated user
                    user.password = undefined;
                    user.salt = undefined;
  
                    res.json(user);
  
                    done(err, user, rbytrUser);
                  }
                });
              }
            });
          });
        } else {
          return res.status(400).send({
            message: 'Invite token is invalid or has expired.'
          });
        }
      });
    },
    // save userId to be followed in rbytr document
    function (user, rbytrUser, done) {
      rbytrUser.following.push(user._id);
      rbytrUser.followedBy.push(user._id);
      rbytrUser.save(function (err) {
        if (err) {
          return res.status(400).send({
            message: errorHandler.getErrorMessage(err)
          });
        } else {
          done(err, user);
        }
      });
    },
    function (user, done) {
      res.render('modules/users/server/templates/invite-authentication-confirm-email', {
        displayName: user.displayName,
        appName: config.app.title
      }, function (err, emailHTML) {
        done(err, emailHTML, user);
      });
    },
    // If valid email, send reset email using service
    function (emailHTML, user, done) {
      var mailOptions = {
        to: user.email,
        from: config.mailer.from,
        subject: 'You are an rbytr now',
        html: emailHTML
      };

      smtpTransport.sendMail(mailOptions, function (err) {
        done(err, 'done');
      });
    }
  ], function (err) {
    if (err) {
      return next(err);
    }
  });
};