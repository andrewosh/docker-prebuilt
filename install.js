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
var sudo = require('sudo-prompt')
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

function sudoExec (cmd) {
  return function (next) {
    sudo.exec(cmd, function (err) {
      return next(err)
    })
  }
}

function downloadFiles (next) {
  debug('in downloadFiles')
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
  sudo.exec('cp ' + path.join(dir, '*') + ' ' + p, function (err) { return next(err) })
}

// stop the Docker daemon if it is already running (after user prompt)
function stopDocker (next) {
  debug('in stopDocker')
  if (platform === 'linux') {
    sudo.exec('killall docker || true', function (err) {
      return next (err)
    })
  } else {
    return next()
  }
}

// ensure that the current user is in the 'docker' group
function configureUser (next) {
  debug('in configureUser')
  if (platform === 'linux') {
    // forcing the group add will only produce a successful return code
    async.series([
      sudoExec('groupadd -f docker'),
      sudoExec('usermod -a -G docker ' + process.env['USER'])
    ], function (err) {
      return next(err)
    })
  } else {
    return next()
  }
}

// launch the daemon
function installDaemon (next) {
  debug('in installDaemon')
  if (platform === 'linux') {
    // check if systemd is being used, if so, add the systemd unit files
    fs.exists('/etc/systemd/system', function (exists) {
      if (exists) {
        debug('using systemd')
        var confPath = path.join(__dirname, 'daemon', 'systemd', '*')
        async.series([
          sudoExec('cp ' + confPath + ' /etc/systemd/system'),
          sudoExec('systemctl restart docker')
        ], function (err) {
          return next(err)
        })
      }
    })
  } else {
    return next()
  }
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
  downloadFiles,
  extractFiles,
  moveFiles,
  stopDocker,
  configureUser,
  installDaemon
], function (err) {
  if (err) {
    console.error('could not install docker:', err)
    process.exit(2)
  }
  console.log('successfully installed docker')
  process.exit(0)
})
