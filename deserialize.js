module.exports = function deserialize (val, asBuffer) {
  const type = Object.keys(val)[0]
  const value = val[type]

  const reduce = function (value) {
    return Object.keys(value).reduce((acc, key) => {
      acc[key] = deserialize(value[key], asBuffer)
      return acc
    }, {})
  }

  switch (type) {
    case 'NULL' : return asBuffer === false ? null : new Buffer(0)
    case 'S' : return asBuffer === false ? value : new Buffer(value)
    case 'B' : return value
    case 'BOOL' : return value
    case 'N' : return parseFloat(value, 10)
    case 'L' : return value.map(deserialize, asBuffer)
    case 'M' : return reduce(value)
    default : throw new Error(`cannot parse ${type}.`)
  }
}
