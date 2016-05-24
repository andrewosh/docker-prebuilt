#!/usr/bin/env node
var os = require('os')
var path = require('path')
var proc = require('child_process')

var fs = require('fs-extra')
var async = require('async')
var uname = require('node-uname')
var semver = require('semver')
var download = require('prebuilt-download')
var capitalize = require('lodash.capitalize')
var sudo = require('sudo')
var debug = require('debug')('docker-prebuilt')

var pumpify = require('pumpify')
var gunzip = require('gunzip-maybe')
var tar = require('tar-fs')

var util = require('./util')
var trimSplit = util.trimSplit
var versionCheck = util.versionCheck
var ensureMinVersion = util.ensureMinVersion

var version  = require('./package').version.replace(/-.*/, '')
var platform = os.platform()

if (platform !== 'linux') {
  console.error('unsupported platform: ', os.platform())
  process.exit(2)
}

var onerror = function (err) {
  throw err
}

// ensure that the kernel version is >= 3.10
try { 
  var uname = uname()
  var kernel = uname.release.split('-')[0]
  if (!versionCheck(kernel, '3.10', semver.gte)) {
    console.error('unsupported kernel version:', kernel)
    process.exit(2)
  }
  if (uname.machine !== 'x86_64') {
      console.error('docker requires a 64-bit linux installation')
      process.exit(2)
  }
} catch (err) {
  console.error('could not check kernel version with uname:', err)
}


// ensure that all the required executables are present
ensureMinVersion('git', '1.7', function (v) { return trimSplit(v)[2] })
ensureMinVersion('iptables', '1.4', function (v) { return trimSplit(v)[1] })
ensureMinVersion('xz', '4.9', function (v) {
  var raw = trimSplit(v)[3].split('\n')[0]
  return raw.replace(/(alpha|beta)/g, '')
})
ensureMinVersion('ps', '0.0', function (v) { return trimSplit(v)[2] })

// check if this docker version is already installed
try {
  var dockerVersion = trimSplit(proc.execSync('docker --version', { encoding: 'utf8' }))[2].slice(0, -1)
  console.log('dockerVersion:', dockerVersion)
  if (dockerVersion === version) {
    console.log('current docker version matches requested installation version')
    process.exit(0)
  }
} catch (err) {
  // do nothing (docker does not exist)
}

debug('all requirements met, installing docker', version)

// TODO: add other platforms!
var paths = {
  linux: 'dist/docker'
}
var binPaths = {
  linux: '/usr/local/bin'
}

var filename = 'docker-{version}.tgz'

function dl (next) { 
  debug('in dl')
  download({
    name: 'docker',
    filename: filename,
    version: version,
    arch: function (a) {
      if (a === 'ia32') { return 'i386'
      } else if (a === 'x64') {
        return 'x86_64'
      }
      return a
    },
    platform: function (p) {
      return capitalize(p)
    },
    url: 'https://get.docker.com/builds/{platform}/{arch}/' + filename
  }, next)
}

// copy all binaries to /usr/bin
function moveFiles (next) {
  var dir = path.join(__dirname, 'dist', 'docker')
  var p = binPaths[platform]
  var options = {
    cachePassword: true,
    prompt: 'Enter sudo password to copy binaries to ' + p + ':',
    spawnOptions: { encoding: 'utf8' }
  }
  var child = sudo(['cp', path.join(dir, '*'), p], options)
  child.stdout.on('end', function (data) {
    return next(null)
  })
  child.stderr.on('error', function  (err) {
    return next(null)
    child.destroy()
  })
}

// stop the Docker daemon if it is already running (after user prompt)
function stopDocker (next) {
  debug('in stopDocker')
  var options = {
    cachePassword: true,
    prompt: 'Enter sudo password to kill docker daemon:',
    spawnOptions: { encoding: 'utf8' }
  }
  var child = sudo(['killall', 'docker'], options)
  child.stdout.on('end', function (data) {
    return next(null)
  })
  child.stderr.on('error', function  (err) {
    return next(null)
    child.destroy()
  })
}

// ensure that the current user is in the 'docker' group
function configureUser (next) {
  debug('in configureUser')
  var options = {
    cachePassword: true,
    prompt: 'Enter sudo password to add user to docker group:',
    spawnOptions: { encoding: 'utf8' }
  }
  var child = sudo(['useradd', '-G', 'docker',  String(process.getuid())], options)
  child.stdout.on('end', function () {
    return next(null)
  })
  child.stderr.on('data', function  (err) {
    debug('in configureUser, err:', err)
    return next(err)
  })
}

// unzips and makes path.txt point at the correct executable
function extractFiles (tarPath, next) {
  debug('in extractFiles')
  fs.writeFile(path.join(__dirname, 'path.txt'), paths[platform], function (err) {
    if (err) return onerror(err)
    var untar = pumpify(gunzip(), tar.extract(path.join(__dirname, 'dist')))
    var stream = fs.createReadStream(tarPath).pipe(untar)
    debug('extracting tarball...')
    untar.on('error', function (err) {
      debug('errored')
      return next(err)
    })
    untar.on('finish', function () {
      debug('finish')
      return next(null)
    })
  })
}

async.waterfall([
  dl,
  extractFiles,
  moveFiles,
  stopDocker,
  configureUser
], function (err) {
  if (err) {
    console.error('could not install docker:', err)
    process.exit(2)
  }
  console.log('successfully installed docker')
  process.exit(0)
})
