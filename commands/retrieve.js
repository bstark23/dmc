var user        = require('../lib/user');
var _           = require('lodash');
var logger      = require('../lib/logger');
var cliUtil     = require('../lib/cli-util');
var sfClient    = require('../lib/sf-client');
var metadata    = require('../lib/metadata');
var metaMap     = require('../lib/metadata-map');
var async       = require('async');
var Promise     = require('bluebird');
var minimatch   = require('minimatch');
var streamifier = require('streamifier');
var unzip       = require('unzip');
var paths       = require('../lib/paths');
var fs          = require('../lib/fs');

var matchOpts = { matchBase: true };

function getFilePaths(typeGroups, oauth) {
  return new Promise(function(resolve, reject) {

    var iterator = function(types, cb) {
      sfClient.meta.listMetadata({
        oauth: oauth,
        queries: _.map(types, function(t) {
          return {
            type: t.name
          };
        })
      }).then(function(res) {

        if(!res || !res.length) {
          return cb(null, null);
        }

        var filePaths = _(res)
          .flattenDeep()
          .map(function(md) {
            return 'src/' + md.fileName
          })
          .value();

        cb(null, filePaths);
      }).catch(function(err) {
        console.error(err.root);
        cb(err);
      });
    };

    async.mapLimit(typeGroups, 5, iterator, function(err, res) {
      if(err) return reject(err);
      var files = _(res)
        .compact()
        .flattenDeep()
        .uniq()
        .value();

      resolve(files);
    });
  });
}

function filterOnGlobs(paths, globs) {
  return _(paths)
    .filter(function(p) {
      var match = false;

      _.each(globs, function(g) {
        if(minimatch(p, g, matchOpts)) {
          match = true;
          return false;
        }
      });

      return match;
    })
    .value();
}

function unzipToTmp(zipBase64) {
  console.log('unzipping to tmp dir: ' + paths.dir.tmp);
  return new Promise(function(resolve, reject) {

    streamifier.createReadStream(new Buffer(zipBase64, 'base64'))
      .pipe(unzip.Extract({ path: paths.dir.tmp }))
      .on('close', function(){
        logger.log('close event');
        resolve();
      })
      .on('error', function(err){
        logger.error('unable to unpack zip file');
        reject(err)
      });

  });
}

function removeTmpDir() {
  console.log('removing tmp');
  return fs.removeAsync(paths.dir.tmp);
};

function removeLocalSrc() {

};

var run = module.exports.run = function(opts, cb) {

  var map;

  var typeMatches = metadata.getTypesFromGlobs(opts.globs);

  // log out the matched directories
  _.each(typeMatches, function(tm) {
    logger.list(tm.folder);
  });

  // group the metadata into groups of 3 since that's the limit
  // in a single listMetadata call
  var grouped = _.chunk(typeMatches, 3);

  getFilePaths(grouped, opts.oauth).then(function(paths) {
    return filterOnGlobs(paths, opts.globs);
  }).then(function(filteredPaths) {

    map = metaMap.createMap({
      oauth: opts.oauth
    });

    map.addFiles(filteredPaths);

    var apiVersion = sfClient.apiVersion.replace('v', '');

    var promise = sfClient.meta.retrieveAndPoll({
      oauth: opts.oauth,
      apiVersion: apiVersion,
      unpackaged: {
        version: apiVersion,
        types: map.createTypesArray()
      }
    });

    promise.poller.on('poll', function(res) {
      logger.log('retrieve status: ' + res.status);
    });

    return promise;

  }).then(function(res){
    return unzipToTmp(res.zipFile);
  }).then(function() {
    logger.log('cleaning up temporary files');
    return removeTmpDir();
  }).catch(function(err) {
    cb(err);
  });

};

module.exports.cli = function(program) {
  program.command('retrieve [globs...]')
    .description('retrieve metadata from target org')
    .option('-o, --org <org>', 'the Salesforce organization to use')
    .option('-l, --local-only', 'only retrieve metadata that exists locally')
    .option('-r, --replace', 'replace all local metadata with the retrieved metadata')
    .option('--meta', 'force retrieve with metadata api')
    .action(function(globs, opts) {
      opts.globs = globs;
      return cliUtil.executeRun(run)(opts);
    });
};
