var semver = require('semver')
var proc = require('child_process')

var versionCheck = function  (v1, v2, func) {
  var pad = function (v, l) {
    var toPad = Math.max(0, l - v.length) 
    for (var i = 0; i < toPad; i++) {
      v.push(0)
    }
    return v.join('.')
  }
  v1 = v1.split('.')
  v2 = v2.split('.')
  console.log('padded1', pad(v1, 3), 'padded2', pad(v2, 3))
  return func(pad(v1, 3), pad(v2, 3))
}

var ensureMinVersion = function (bin, version, strip) {
  try { 
    var raw = proc.execSync(bin + ' --version', { encoding: 'utf8' })
    var v  = strip(raw)
    console.log('version:', version, 'v:', v)
    if (!versionCheck(v, version, semver.gte)) {
      console.error('docker requires', bin, '>=', version)
      process.exit(2)
    }
  } catch (err) {
    console.error('could not check version of required binary', bin, ':', err)
  }
}

var trimSplit = function (x) { return x.trim().split(' ') }

module.exports =  {
  ensureMinVersion: ensureMinVersion,
  trimSplit: trimSplit,
  versionCheck: versionCheck
}
