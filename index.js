'use strict'
const AWS = require('aws-sdk')
const AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN

const serialize = require('./serialize')
const deserialize = require('./deserialize')
const DynamoDBIterator = require('./iterator')

AWS.config.apiVersions = {dynamodb: '2012-08-10'}

class DynamoDBDOWN extends AbstractLevelDOWN {
  constructor (location) {
    super(location)

    const tableHash = location.split('/')

    this.tableName = tableHash[0]
    this.hashKey = tableHash[1] || '!'
  }

  _open (options, cb) {
    if (!options.dynamodb) {
      return cb(new Error('`open` requires `options` argument with "dynamodb" key'))
    }

    const dynamodbOptions = Object.assign({tableName: this.tableName}, options.dynamodb)

    this.dynamoDb = new AWS.DynamoDB(dynamodbOptions)

    if (options.createIfMissing) {
      this.createTable({
        ProvisionedThroughput: dynamodbOptions.ProvisionedThroughput
      }, (err, data) => {
        const exists = err && (err.code === 'ResourceInUseException')

        if (options.errorIfExists && exists || err && !exists) {
          return cb(err)
        }

        return cb(null, this)
      })
    } else {
      setImmediate(() => {
        return cb(null, this)
      })
    }
  }

  _close (cb) {
    this.dynamoDb = null
    setImmediate(function () {
      return cb(null)
    })
  }

  _put (key, value, options, cb) {
    const params = {
      TableName: this.tableName,
      Item: {
        hkey: {S: this.hashKey.toString()},
        rkey: {S: key.toString()},
        value: serialize(value, options.asBuffer)
      }
    }

    this.dynamoDb.putItem(params, cb)
  }

  _get (key, options, cb) {
    const params = {
      TableName: this.tableName,
      Key: {
        hkey: {S: this.hashKey.toString()},
        rkey: {S: key.toString()}
      }
    }

    this.dynamoDb.getItem(params, function (err, data) {
      if (err) {
        return cb(err)
      }

      if (!(data && data.Item && data.Item.value)) {
        return cb(new Error('NotFound'))
      }

      return cb(null, deserialize(data.Item.value, options.asBuffer))
    })
  }

  _del (key, options, cb) {
    const params = {
      TableName: this.tableName,
      Key: {
        hkey: {S: this.hashKey.toString()},
        rkey: {S: key.toString()}
      }
    }

    this.dynamoDb.deleteItem(params, function (err, data) {
      if (err) {
        return cb(err)
      }

      cb(null, data)
    })
  }

  _batch (array, options, cb) {
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
              hkey: {S: this.hashKey.toString()},
              rkey: {S: item.key.toString()}
            }
          }
        }
      } else {
        op = {
          PutRequest: {
            Item: {
              hkey: {S: this.hashKey.toString()},
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
      if (err) return cb(err)

      const reqs = []

      if (data && data.UnprocessedItems && data.UnprocessedItems[this.tableName]) {
        reqs.push.apply(reqs, data.UnprocessedItems[this.tableName])
      }

      reqs.push.apply(reqs, ops.splice(0, 25 - reqs.length))

      if (reqs.length === 0) {
        return cb()
      }

      params.RequestItems[this.tableName] = reqs
      this.dynamoDb.batchWriteItem(params, loop)
    }

    loop()
  }

  _iterator (options) {
    return new DynamoDBIterator(this, options)
  }

  createTable (opts, cb) {
    const params = {
      TableName: this.tableName,
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

    this.dynamoDb.createTable(params, cb)
  }
}

module.exports = DynamoDBDOWN
