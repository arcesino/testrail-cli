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
      },
      commands;

  commands = {
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

          (function parseXmlIntoCaseResults(xml) {
            // If the root represents a single testsuite, treat it as such.
            if (xml.root.name === 'testsuite' && xml.root.children && xml.root.children.length) {
              xml.root.children.forEach(function (testcase) {
                var caseResult = {};

                if (testcase.name && testcase.name === 'testcase') {
                  // Universal to pass or fail.
                  caseResult.case_id = commands._resolveCaseIdFrom(testcase);

                  // Only supply an elapsed time if a time was reported.
                  if (testcase.attributes.hasOwnProperty('time')) {
                    // It's possible a time was provided, but it's 0. Round up!
                    testcase.attributes.time = testcase.attributes.time == 0 ? 1 : testcase.attributes.time;
                    caseResult.elapsed = Math.ceil(testcase.attributes.time) + 's';
                  }

                  // If testcase.children is empty, the test case passed. 1 means pass.
                  if (testcase.children.length === 0) {
                    caseResult.status_id = 1;
                  }
                  // Otherwise, there was a failure. 5 means failure. Add fail message.
                  else {
                    caseResult.status_id = 5;
                    if (testcase.children[0].attributes.message){
                      caseResult.comment = HtmlEntities.decode(testcase.children[0].attributes.message);
                    }

                    // If `detailedFailures` set to `true`, include failure's content in the comment
                    if (configs.detailedFailures) {
                      // "failure" elements are expected to have a single text node with relevant data to the failure
                      var failureContent = testcase.children[0].children[0];

                      caseResult.comment += '\n' + HtmlEntities.decode(failureContent.content);
                    }
                  }

                  // Only append tests we've mapped to a TestRail case.
                  if (caseResult.case_id) {
                    debug('Appending case result:'); debug(caseResult);
                    caseResults.push(caseResult);
                  }
                  else {
                    debug('Unable to map testCase to TestRail CaseID:'); debug(testcase);
                  }
                }
              });
            }
            // If the root consists of multiple test suites, recurse.
            else if (xml.root.name === 'testsuites' && xml.root.children) {
              xml.root.children.forEach(function (testSuite) {
                // The base case (above) expects items on the .root property.
                testSuite.root = testSuite;
                parseXmlIntoCaseResults(testSuite);
              });
            }
            // If we map to neither of the above expectations, abort.
            else {
              console.error('Invalid xml. Expected root name testsuite');
              debug(xml);
              process.exit(1);
            }
          })(xml);
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
    },

    /**
     * Helper method to map a testcase (xUnit) to a TestRail caseId.
     *
     * @param {object} testCase
     *   An object representing a single testcase. Should include minimally:
     *   - attributes.name: The name of the test run.
     *   - attributes.class: The class associated with this testcase.
     *
     * @return {int}|null
     *   Returns the caseId or null on failure to match.
     */
    _resolveCaseIdFrom: function resolveCaseIdFromTestCase(testCase) {
      var testClass = HtmlEntities.decode(testCase.attributes.classname),
          testName = HtmlEntities.decode(testCase.attributes.name);

      // If `caseIdRegExp` is configured, try matching a case id in case name.
      if (configs.caseIdRegExp) {
        var matcher = testName.match(configs.caseIdRegExp);
        if(matcher) {
          return matcher[1];
        }
      }

      // First check if there's a matching caseClassAndNameToIdMap class.
      if (configs.caseClassAndNameToIdMap && configs.caseClassAndNameToIdMap[testClass]) {
        // If there's a matching name nested underneath the class, return it.
        if (configs.caseClassAndNameToIdMap[testClass][testName]) {
          return configs.caseClassAndNameToIdMap[testClass][testName];
        }
      }

      // Then check if there's a matching caseNameToIdMap name.
      if (configs.caseNameToIdMap && configs.caseNameToIdMap[testName]) {
        return configs.caseNameToIdMap[testName];
      }

      // Otherwise, return null.
      return null;
    }
  };

  return commands;
};
