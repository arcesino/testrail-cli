"use strict";

var Promise = require('promise'),
    fs = require('fs'),
    readFile = Promise.denodeify(fs.readFile),
    XmlParser = require('xml-parser'),
    HtmlEntitiesFactory = require('html-entities').AllHtmlEntities,
    HtmlEntities = new HtmlEntitiesFactory();

/**
 * Instantiates a "core" object with given dependencies. The object consists of
 * properties that represent methods to be run on corresponding commands.
 *
 * @param TestRail
 * @param {object} configs
 * @param process
 * @param console
 * @returns {{init: Function, finish: Function, report: Function}}
 */
module.exports = function constructCore(TestRail, configs, process, console) {
  process = process || global.process;
  console = console || global.console;

  var apiCallsAttempted = 0,
      maxCallAttemptsAllowed = 5,
      debug = function debug(message) {
        if (configs.debug) {
          console.error(message);
        }
      };

  return {
    /**
     * Initializes/adds a run to TestRail for the given project ID.
     *
     * @param {int} projectId
     *   Required. The project ID for which a new run should be added.
     * @param {string} name
     *   Required. The name of the run to be added.
     * @param {int} suiteId
     *   Optional. The ID of the test suite to be run.
     * @param {string} description
     *   Optional. A description to go along with the test run.
     * @param {int} milestoneId
     *   Optional. The ID of a milestone with which to associate this run.
     */
    init: function initializeTestRun(projectId, name, suiteId, description, milestoneId) {
      debug('Attempting to initialize test run.');

      if (!projectId || !name) {
        console.error('You must supply a projectId (-p or --projectId=) and runName (-n or --runName=).');
        debug('projectId: "' + projectId + '", name: "' + name + '"');
        process.exit(1);
      }

      TestRail.addRun(projectId, suiteId, name, description, milestoneId, function (response) {
        debug('Received response from TestRail.');

        response = typeof response === 'string' ? JSON.parse(response) : response;
        if (response.id) {
          console.log(response.id);
          debug(response);
          process.exit(0);
        }
        else {
          // Retry if we're under the limit.
          if (apiCallsAttempted < maxCallAttemptsAllowed) {
            apiCallsAttempted++;
            debug('Failed to initialize run. Attempt #' + apiCallsAttempted);
            initializeTestRun(projectId, name, suiteId, description, milestoneId);
          }
          else {
            console.error('Error initializing test run in TestRail: ' + response.error);
            debug(response);
            process.exit(1);
          }
        }
      });
    },

    /**
     * Marks a given test run as closed on TestRail.
     *
     * @param {int} runId
     *   Required. The ID of the test run to close.
     */
    finish: function closeTestRun(runId) {
      debug('Attempting to close test run.');

      if (!runId) {
        console.error('You must supply a runId (-r or --runId=).');
        debug('runId: ' + runId);
        process.exit(1);
      }

      TestRail.closeRun(runId, function (response) {
        debug('Received response from TestRail.');

        response = typeof response === 'string' ? JSON.parse(response) : response;
        if (response.completed_on) {
          console.log('Successfully closed test run ' + runId + '.');
          debug(response);
          process.exit(0);
        }
        else {
          if (apiCallsAttempted < maxCallAttemptsAllowed) {
            apiCallsAttempted++;
            debug('Failed to close test run. Attempt #' + apiCallsAttempted);
            closeTestRun(runId);
          }
          else {
            console.error('There was an error closing the test run: ' + response.error);
            debug(response);
            process.exit(1);
          }
        }
      });
    },

    /**
     * Given a junit XML file (or a directory of files), processes all test
     * results, maps them to cases, and pushes the results to TestRail.
     *
     * @param {int} runId
     *   The ID of the run with which to associate the cases.
     * @param {string} fileOrDir
     *   The path to the junit XML file or directory of files.
     */
    report: function reportXml(runId, fileOrDir) {
      var files = [],
          caseResults = [],
          fsStat;

      debug('Attempting to report runs for test cases.');

      if (!fileOrDir || !runId) {
        console.error('You must supply a file (-f or --file=) and runId (-r or --runId=).');
        debug('file: "' + fileOrDir + '", runId: "' + runId + '"');
        process.exit(1);
      }

      // Stat the file.
      fsStat = fs.statSync(fileOrDir);

      if (fsStat.isFile()) {
        // Make sure the provided file is an XML file.
        if (fileOrDir.substring(fileOrDir.length - 4) === '.xml') {
          files.push(fileOrDir);
        }
      }
      else if (fsStat.isDirectory()) {
        // Filter down to just those files that are XML.
        files = fs.readdirSync(fileOrDir).filter(function(dirContent) {
          return dirContent.substring(dirContent.length - 4) === '.xml';
        }).map(function (dirContent) {
          return fileOrDir + (fileOrDir.substring(fileOrDir.length - 1) === '/' ? '' : '/') + dirContent
        });
      }

      // Asynchronously read in all files in the file array.
      debug('Attempting to parse files:'); debug(files);
      Promise.all(files.map(function readFilesPromises(file) {
        return readFile(file, 'utf8');
      })).done(function (fileContents) {
        fileContents.forEach(function (rawXml) {
          var xml = XmlParser(rawXml);

          if (!xml.root.name || xml.root.name !== 'testsuite') {
            console.error('Invalid xml. Expected root name testsuite');
            debug(xml);
            process.exit(1);
          }

          if (xml.root && xml.root.children && xml.root.children.length) {
            xml.root.children.forEach(function (testcase) {
              var caseResult = {};

              if (testcase.name && testcase.name === 'testcase') {
                // Universal to pass or fail.
                caseResult.case_id = configs.caseNameToIdMap[HtmlEntities.decode(testcase.attributes.name)];
                caseResult.elapsed = Math.ceil(testcase.attributes.time) + 's';
                caseResult.version = 'test';

                // If testcase.children is empty, the test case passed. 1 means pass.
                if (testcase.children.length === 0) {
                  caseResult.status_id = 1;
                }
                // Otherwise, there was a failure. 5 means failure. Add fail message.
                else {
                  caseResult.status_id = 5;
                  caseResult.comment = HtmlEntities.decode(testcase.children[0].attributes.message);
                }

                debug('Appending case result:'); debug(caseResult);
                caseResults.push(caseResult);
              }
            });
          }
        });

        // Post results if we had any.
        if (caseResults.length) {
          (function addResultsForCasesAttempt() {
            debug('Attempting to send case results to TestRail');

            TestRail.addResultsForCases(runId, {results: caseResults}, function (response) {
              response = typeof response === 'string' ? JSON.parse(response) : response;

              debug('Received response from TestRail.');

              if (response instanceof Array && response.length) {
                console.log('Successfully uploaded ' + response.length + ' test case results to TestRail.');
                debug(response);
                process.exit(0);
              }
              else {
                if (apiCallsAttempted < maxCallAttemptsAllowed) {
                  apiCallsAttempted++;
                  debug('Failed to upload case runs. Attempt #' + apiCallsAttempted);
                  addResultsForCasesAttempt();
                }
                else {
                  console.error('There was an error uploading test results to TestRail: ' + response.error);
                  debug(response);
                  debug(caseResults);
                  process.exit(1);
                }
              }
            });
          })();
        }
        else {
          console.log('Did not parse any test XML files.');
        }
      });
    }
  };
};
