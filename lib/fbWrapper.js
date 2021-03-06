if((typeof FormBuilder) !== "object") FormBuilder = {};
if(Meteor.isClient){
  FormBuilder.forms = new Mongo.Collection(null); //store the current form data in a client side collection
  FormBuilder.views = new Mongo.Collection(null); //store the current view data in a client side collection
  Template.fbWrapper.helpers({
    //Gets the array of views from the relevant data store for the form
    getViews: function () {
      var tmpl = Template.instance();
      return FormBuilder.views.find({parentID:tmpl.dataID}, {sort: {position : 1 }});
    },
    getTemplate: function(){
      return Template[this.template];
    },
    getForm: function(){
      var tmpl = Template.instance();
      return FormBuilder.forms.findOne({_id:tmpl.dataID});
    }
  });
  //When the template is created make an object that will store the view of the form
  Template.fbWrapper.created = function(){
    var template = this;
    //Create the form object and get the ID
    var formObj = _.pick(template.data, 'hookID','collection', 'type', 'document', 'labelWidth', 'inputWidth', 'filter');
    var defaultFilter = 0xFFFF;
    if(formObj.type === 'create') {
      formObj.isCreate = true; 
      defaultFilter = 0x0001;
    }
    else if(formObj.type === 'update') {
      formObj.isUpdate = true;
      defaultFilter = 0x0002;
    }
    else if(formObj.type === 'read') {
      formObj.isRead = true;
      defaultFilter = 0x0004;
    }
    formObj = _.defaults(formObj, {type:'read', labelWidth:3, inputWidth:9, filter:defaultFilter});
    //Check that the collection is specified and is valid
    if(((typeof formObj.collection) !== 'string') || !window || !window[formObj.collection]){
        console.warn('FormBuilder fbWrapper should be used with collection as a string parameter.');
        return;
      }
    var collection = window[formObj.collection];
    //Check that a schema has been specified
    if((typeof collection.schema) !== 'object'){
      console.warn('FormBuilder fbWrapper should be used with a collection that has a schema object.');
      return;
    }
    template.dataID = FormBuilder.forms.insert(formObj);
    
    formObj = FormBuilder.forms.findOne(template.dataID);
    //The position object is used for sorting the views, it is incremented internally inside the addViews method
    var position = {value:0};
    //Iterate over the schema object calling the add views method on each one 
    _.each(_.keys(collection.schema), function(fieldName){
      var schemaObj = collection.schema[fieldName];
      //Get the controller for this database field
      if(((typeof schemaObj.controller) !== 'string') || !FormBuilder.controllers[schemaObj.controller])
        console.warn(formObj.collection + '.schema.' + fieldName + ' controller ' + schemaObj.controller + ' not found.');
      else{
        FormBuilder.controllers[schemaObj.controller].addViews(fieldName, formObj, schemaObj, position, formObj._id);
      }
    });
    if(formObj.isRead || formObj.isUpdate)
      FormBuilder.helpers.loadCurrentValues(formObj._id);
  };

  //When the template is destroyed remove the data store
  Template.fbWrapper.destroyed = function(){
    //Remove all views for this form
    FormBuilder.views.find({'formObj._id':this.dataID}).forEach(function(field){
      FormBuilder.views.remove({_id:field._id});
    });
    //Remove the form
    FormBuilder.forms.remove({_id:this.dataID});
  };

  Template.fbWrapper.events({
    //When submit is pressed try to insert, if an error is shown update the data store to show the error
    'submit form': function(event, template) {
      event.preventDefault();
      var formObj = FormBuilder.forms.findOne({_id:template.dataID});
      FormBuilder.helpers.getCurrentValues(formObj,function(doc){
        var databaseCallback = function(errors, id){
          var error = !!errors;
          if(error) {
            try{
              errors = JSON.parse(errors.reason);
            }catch(e){
              alert(errors.reason);
            }
          }
          else errors = {};

          var collection = window[formObj.collection];
          //Iterate over the schema object calling the set error method on each one 
          var position = {value:0};
          _.each(_.keys(collection.schema), function(fieldName){
            var schemaObj = collection.schema[fieldName];
            FormBuilder.controllers[schemaObj.controller].setError(fieldName, formObj._id, position, errors, id);
          });      
          if(formObj.isCreate){
              if(typeof hooks.afterCreate[formObj.hookID] === 'function')
                hooks.afterCreate[formObj.hookID].apply(formObj, [doc, error]);
            }
            else if(formObj.isUpdate){
              if(typeof hooks.afterUpdate[formObj.hookID] === 'function')
                hooks.afterUpdate[formObj.hookID].apply(formObj, [doc, error]);
            }
        };

        if(formObj.isCreate){
          //Check for hooks, the function must return true if the insert can carry on
          if(typeof hooks.beforeCreate[formObj.hookID] === 'function')
            if(!hooks.beforeCreate[formObj.hookID].apply(formObj, [doc])) return;
          window[formObj.collection].insert(doc, databaseCallback);
        }
        else if(formObj.isUpdate){
          if(typeof hooks.beforeUpdate[formObj.hookID] === 'function')
            if(!hooks.beforeUpdate[formObj.hookID].apply(formObj, [doc])) return;
          updateCount = window[formObj.collection].update({_id:formObj.document}, {$set:doc}, databaseCallback);
        }
      });
    }
  });
}

if(Meteor.isServer){
  //A temporary collection for previewing the results of an update
  FormBuilder.temp = new Mongo.Collection(null);
  //This object is passed to a Collection.deny function to enable data validation
  FormBuilder.validate = function(collectionID){
    var validate = function(userId, doc, docID, colID){
      if(!doc)
        throw new Meteor.Error(403, "validate called without a valid document!");
      var errors = {};
      var collection = this[colID];
      if(!collection)
        throw new Meteor.Error(403, "validate called without a valid collection! ("+ colID+")");
      _.each(_.keys(doc), function(fieldName){
        var schemaObj = collection.schema[fieldName] || {};
        var value = doc[fieldName];
        var controller = schemaObj.controller;
        if(((typeof controller) !== 'string') || !FormBuilder.controllers[controller])
          errors[fieldName] = colID + '.schema.' + fieldName + ' fieldBuilder ' + controller + ' not found.';
        else{
          var message = FormBuilder.controllers[controller].validate.call(this, fieldName, value, schemaObj, collection, docID);
          if (message !== false) errors[fieldName] = message;
        }
      });
      if(!_.isEmpty(errors)) throw new Meteor.Error(403, JSON.stringify(errors));
      return false;
    };
    return {
      insert: function (userId, doc) {
        return validate(userId, doc, null, collectionID);
      },
      update: function (userId, doc, fields, modifier) {
        FormBuilder.temp.remove({});
        FormBuilder.temp.insert(doc);
        FormBuilder.temp.update(doc._id, modifier);
        var updatedDoc = FormBuilder.temp.findOne(doc._id);
        var filteredDoc = _.pick(updatedDoc, fields);
        return validate(userId, filteredDoc, doc._id, collectionID);
        FormBuilder.temp.remove({});
      }
    };
  };
}