'use strict'
const inherits = require('util').inherits
const AWS = require('aws-sdk')
const AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN

const serialize = require('./serialize')
const deserialize = require('./deserialize')
const DynamoDBIterator = require('./iterator')

const MAX_BATCH_SIZE = 25
const RESOURCE_WAITER_DELAY = 1

const globalStore = {}

AWS.config.apiVersions = {dynamodb: '2012-08-10'}

function DynamoDBDOWN (location) {
  if (!(this instanceof DynamoDBDOWN)) {
    return new DynamoDBDOWN(location)
  }

  AbstractLevelDOWN.call(this, location)

  const tableHash = location.split('$')

  this.tableName = tableHash[0]
  this.hashKey = tableHash[1] || '!'

  globalStore[location] = this
}

inherits(DynamoDBDOWN, AbstractLevelDOWN)

function hexEncodeTableName (str) {
  var hex = ''

  for (var pos = 0; pos < str.length; pos++) {
    hex += String(str.charCodeAt(pos).toString(16))
  }

  return hex
}

DynamoDBDOWN.prototype._open = function (options, cb) {
  if (!options.dynamodb) {
    cb(new Error('`open` requires `options` argument with "dynamodb" key'))
    return
  }

  if (typeof options.prefix === 'string') {
    this.tableName = this.tableName.replace(options.prefix, '')
  }

  if (options.dynamodb.hexEncodeTableName === true) {
    this.encodedTableName = hexEncodeTableName(this.tableName)
  } else {
    this.encodedTableName = this.tableName
  }

  const dynamodbOptions = Object.assign({tableName: this.encodedTableName}, options.dynamodb)

  this.dynamoDb = new AWS.DynamoDB(dynamodbOptions)

  if (options.createIfMissing !== false) {
    this.createTable({
      ProvisionedThroughput: dynamodbOptions.ProvisionedThroughput
    }, (err, data) => {
      const exists = err && (err.code === 'ResourceInUseException')

      if (options.errorIfExists && exists || err && !exists) {
        cb(err)
      } else {
        cb(null, this)
      }
    })
  } else {
    cb(null, this)
  }
}

DynamoDBDOWN.prototype._put = function (key, value, options, cb) {
  const params = {
    TableName: this.encodedTableName,
    Item: {
      hkey: {S: this.hashKey},
      rkey: {S: key.toString()},
      value: serialize(value, options.asBuffer)
    }
  }

  this.dynamoDb.putItem(params, cb)
}

DynamoDBDOWN.prototype._get = function (key, options, cb) {
  const params = {
    TableName: this.encodedTableName,
    Key: {
      hkey: {S: this.hashKey},
      rkey: {S: key.toString()}
    }
  }

  this.dynamoDb.getItem(params, function (err, data) {
    if (err) {
      cb(err)
    } else if (!(data && data.Item && data.Item.value)) {
      cb(new Error('NotFound'))
    } else {
      cb(null, deserialize(data.Item.value, options.asBuffer))
    }
  })
}

DynamoDBDOWN.prototype._del = function (key, options, cb) {
  const params = {
    TableName: this.encodedTableName,
    Key: {
      hkey: {S: this.hashKey},
      rkey: {S: key.toString()}
    }
  }

  this.dynamoDb.deleteItem(params, cb)
}

DynamoDBDOWN.prototype._batch = function (array, options, cb) {
  const opKeys = {}

  const ops = []

  array.forEach((item) => {
    if (opKeys[item.key]) {
      // We want to ensure that there are no duplicate keys in the same
      // batch request, as DynamoDB won't accept those. That's why we only
      // retain the last operation here.
      const idx = ops.findIndex(someItem => {
        return someItem.DeleteRequest && someItem.DeleteRequest.Key.rkey.S === item.key ||
          someItem.PutRequest && someItem.PutRequest.Item.rkey.S === item.key
      })

      if (idx !== -1) {
        ops.splice(idx, 1)
      }
    }

    var op

    opKeys[item.key] = true

    if (item.type === 'del') {
      op = {
        DeleteRequest: {
          Key: {
            hkey: {S: this.hashKey},
            rkey: {S: item.key.toString()}
          }
        }
      }
    } else {
      op = {
        PutRequest: {
          Item: {
            hkey: {S: this.hashKey},
            rkey: {S: item.key.toString()},
            value: serialize(item.value, options.asBuffer)
          }
        }
      }
    }

    ops.push(op)
  })

  const params = {RequestItems: {}}

  const loop = (err, data) => {
    if (err) {
      cb(err)
      return
    }

    const reqs = []

    if (data && data.UnprocessedItems && data.UnprocessedItems[this.encodedTableName]) {
      reqs.push.apply(reqs, data.UnprocessedItems[this.encodedTableName])
    }

    reqs.push.apply(reqs, ops.splice(0, MAX_BATCH_SIZE - reqs.length))

    if (reqs.length === 0) {
      cb()
    } else {
      params.RequestItems[this.encodedTableName] = reqs
      this.dynamoDb.batchWriteItem(params, loop)
    }
  }

  loop()
}

DynamoDBDOWN.prototype._iterator = function (options) {
  return new DynamoDBIterator(this, options)
}

DynamoDBDOWN.prototype.createTable = function (opts, cb) {
  const params = {
    TableName: this.encodedTableName,
    AttributeDefinitions: [
      {AttributeName: 'hkey', AttributeType: 'S'},
      {AttributeName: 'rkey', AttributeType: 'S'}
    ],
    KeySchema: [
      {AttributeName: 'hkey', KeyType: 'HASH'},
      {AttributeName: 'rkey', KeyType: 'RANGE'}
    ]
  }

  params.ProvisionedThroughput = opts.ProvisionedThroughput || {
    ReadCapacityUnits: 1,
    WriteCapacityUnits: 1
  }

  this.dynamoDb.createTable(params, (err, data) => {
    if (err) {
      cb(err)
    } else {
      this.dynamoDb.waitFor(
        'tableExists',
        {TableName: this.encodedTableName, $waiter: {delay: RESOURCE_WAITER_DELAY}},
        cb)
    }
  })
}

DynamoDBDOWN.destroy = function (name, cb) {
  const store = globalStore[name]

  if (store) {
    store.dynamoDb.deleteTable({TableName: store.encodedTableName}, (err, data) => {
      if (err && err.code === 'ResourceNotFoundException') {
        delete globalStore[name]
        cb()
      } else if (err) {
        cb(err)
      } else {
        store.dynamoDb.waitFor(
          'tableNotExists',
          {TableName: store.encodedTableName, $waiter: {delay: RESOURCE_WAITER_DELAY}},
          (err, data) => {
            if (err) {
              cb(err)
            } else {
              delete globalStore[name]
              cb()
            }
          }
        )
      }
    })
  } else {
    cb(new Error('NotFound'))
  }
}

module.exports = DynamoDBDOWN
