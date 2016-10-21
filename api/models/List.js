'use strict'

const Model = require('trails-model')
const Schema = require('mongoose').Schema

/**
 * @module List
 * @description List Model
 */
module.exports = class List extends Model {

  static config () {
  }

  static schema () {
    return {
      name: {
        type: String
      },

      // Acronym for organizations
      acronym: {
        type: String,
        trim: true
      },

      label: {
        type: String,
        trim: true,
        required: [true, 'Label is required']
      },

      type: {
        type: String,
        enum: ['operation', 'bundle', 'disaster', 'list', 'organization'],
        required: [true, 'Type is required']
      },

      visibility: {
        type: String,
        enum: ['me', 'inlist', 'all', 'verified'],
        required: [true, 'Visibility is required']
      },

      joinability: {
        type: String,
        enum: ['public', 'moderated', 'private'],
        required: [true, 'Joinability is required']
      },

      // TODO: make sure it can not be set through the API
      remote_id: {
        type: Number
      },

      owner: {
        type: Schema.ObjectId,
        ref: 'User'
      },

      managers: [{
        type: Schema.ObjectId,
        ref: 'User'
      }],

      // TODO: make sure it can not be set through the API
      metadata: {
        type: Schema.Types.Mixed
      }
    }
  }

  static onSchema(schema) {
    // TODO: remove all checkins from users in this list
    schema.pre('save', function (next) {
      if (this.acronym) {
        this.name = this.label + ' (' + this.acronym + ')'
      }
      else {
        this.name = this.label
      }
      next ();
    });
    schema.pre('update', function (next) {
      if (this.acronym) {
        this.name = this.label + ' (' + this.acronym + ')'
      }
      else {
        this.name = this.label
      }
    });
    /*schema.post('remove', function (next) {
      orm['listuser'].find({list: this._id}).remove(function (err) {
        console.log('removed listusers');
        next ();
      });
    });*/
  }

}
