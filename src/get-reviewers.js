var shuffle = require('knuth-shuffle');
var Promise = require('native-promise-only');
var minimatch = require('minimatch');

var BlameRange = require('./models/blame-range');
var PullRequestFile = require('./models/pull-request-file');
var Config = require('./models/config');

/**
 * Compute the relevant reviewers of a pull request
 * @param  {Object} options
 * @param  {Object} options.config - Pull Review configuration object
 * @param  {Array}  options.files - list of GitHub pull request files
 * @param  {Array}  options.commits - list of pull request commits
 * @param  {Array}  options.assignees - list of pull request assignees
 * @param  {String} options.authorLogin - username of the pull request author
 * @param  {Function} options.getBlameForFile - function that returns Git blame data for pull request file
 * @param  {Boolean} options.retryReview - unassign current reviewers and assign new reviewers excluding previous reviewers
 * @return {Array} list of reviewers
 */
module.exports = function getReviewers(options) {
  options = options || {};
  var config = options.config || {
    version: 1
  };
  var files = options.files || [];
  var commits = options.commits || [];
  var assignees = options.assignees || [];
  var authorLogin = options.authorLogin;
  var getBlameForFile = options.getBlameForFile;
  var getOrganizationMembers = options.getOrganizationMembers;
  var retryReview = Boolean(options.retryReview);

  if (!getBlameForFile) {
    throw Error('No function provided for retrieving blame for a file');
  } else if (!authorLogin) {
    throw Error('No pull request author provided');
  }

  config = Config(config);

  var maxReviewers = config.maxReviewers;
  var minReviewers = config.minReviewers;
  var maxFilesPerReviewer = config.maxFilesPerReviewer;
  var maxLinesPerReviewer = config.maxLinesPerReviewer;
  var minAuthorsOfChangedFiles = config.minAuthorsOfChangedFiles;
  var maxReviewersAssignedDynamically =
    maxFilesPerReviewer > 0 || maxLinesPerReviewer > 0;
  var fileBlacklist = config.fileBlacklist;
  var reviewPathFallbacks = config.reviewPathFallbacks;
  var reviewPathAssignments = config.reviewPathAssignments;
  var requiredOrganizations = config.requiredOrganizations;

  files = files.map(PullRequestFile);

  if (fileBlacklist.length) {
    fileBlacklist.forEach(function(pattern) {
      files = files.filter(function(file) {
        return !minimatch(file.filename, pattern, {
          dot: true,
          matchBase: true
        });
      });
    });
  }

  var nonRemovedFiles = files.filter(function(file) {
    return file.status !== 'removed';
  });

  var changedLines = Math.abs(
    nonRemovedFiles.reduce(function(sum, file) {
      return sum + (file.additions - file.deletions);
    }, 0)
  );

  var modifiedFiles = files.filter(function(file) {
    return file.status === 'modified';
  });

  modifiedFiles.sort(function(a, b) {
    return b.changes - a.changes;
  });

  var topModifiedFiles = modifiedFiles.slice(0, config.maxFiles);

  var allowedUsers = {};
  var selectedReviewers = {};
  var excludedReviewers = {};
  var currentCommitters = {};
  var uniqueAuthors = 0;

  commits.forEach(function(commit) {
    currentCommitters[commit.author.login] = true;
  });

  if (retryReview) {
    if (assignees.length) {
      assignees.forEach(function(assignee) {
        excludedReviewers[assignee] = true;
      });
    }

    assignees = [];
  }

  assignees = assignees.filter(function(assignee) {
    return assignee !== authorLogin;
  });

  if (assignees.length >= maxReviewers) {
    throw Error('Pull request has maximum reviewers assigned');
  } else if (assignees.length >= minReviewers) {
    throw Error('Pull request has minimum reviewers assigned');
  }

  var unassignedReviewers = maxReviewers - assignees.length;
  var maxNeededReviewers = unassignedReviewers;

  var maxReviewersUsingLines =
    maxLinesPerReviewer > 0 ? Math.ceil(changedLines / maxLinesPerReviewer) : 0;
  var maxReviewersUsingFiles =
    maxFilesPerReviewer > 0 ? Math.ceil(files.length / maxFilesPerReviewer) : 0;

  if (maxReviewersAssignedDynamically) {
    if (!maxFilesPerReviewer && maxLinesPerReviewer) {
      maxNeededReviewers = maxReviewersUsingLines;
    } else if (!maxLinesPerReviewer && maxFilesPerReviewer) {
      maxNeededReviewers = maxReviewersUsingFiles;
    } else {
      maxNeededReviewers = Math.min(
        maxReviewersUsingLines,
        maxReviewersUsingFiles
      );
    }

    maxNeededReviewers = Math.max(minReviewers, maxNeededReviewers);
  }

  var maxReviewersAssignable = Math.min(
    unassignedReviewers,
    maxNeededReviewers
  );
  var minReviewersAssignable = maxReviewersAssignedDynamically
    ? maxReviewersAssignable
    : minReviewers;

  /**
   * @param  {String} reviewer - reviewer username
   * @return {Boolean} is reviewer eligible for this review request?
   */
  function isEligibleReviewer(reviewer) {
    var isReviewerSelected = selectedReviewers[reviewer];
    var isReviewerCurrentCommitter = currentCommitters[reviewer];
    var isReviewerAuthor = reviewer === authorLogin;
    var isReviewerUnreachable = (config.requireNotification && !config.reviewers[reviewer]);
    var isReviewerBlacklisted =
      config.reviewBlacklist && config.reviewBlacklist.indexOf(reviewer) !== -1;
    var isReviewerExcluded = excludedReviewers[reviewer];
    var isReviewerDisallowed = requiredOrganizations.length && !allowedUsers[reviewer];
    return (
      !isReviewerCurrentCommitter &&
      !isReviewerUnreachable &&
      !isReviewerBlacklisted &&
      !isReviewerDisallowed &&
      !isReviewerExcluded &&
      !isReviewerSelected &&
      !isReviewerAuthor
    );
  }

  var assignedReviewers = [];

  return Promise.all(requiredOrganizations.map(getOrganizationMembers))
    .then(function (users) {
      allowedUsers = users.reduce(function (map, user) {
        map[user] = true;
        return map;
      }, {});

      Object.keys(reviewPathAssignments || {})
        .forEach(function(pattern) {
          var matchingFiles = files.filter(function(file) {
            return minimatch(file.filename, pattern, {
              dot: true,
              matchBase: true
            });
          });

          matchingFiles.forEach(function() {
            var assignedAuthors = reviewPathAssignments[pattern] || [];

            assignedAuthors.forEach(function(author) {
              if (!isEligibleReviewer(author)) {
                return;
              }

              assignedReviewers.push({
                login: author,
                count: 0,
                source: 'assignment'
              });

              selectedReviewers[author] = true;
            });
          });
        });

      shuffle.knuthShuffle(assignedReviewers);

      return Promise.all(topModifiedFiles.map(getBlameForFile))
    })
    .then(function(fileBlames) {
      var authorsLinesChanged = {};
      var filesWithOwnership = [];
      var authorOwnership = {};

      for (var i = 0; i < fileBlames.length; i++) {
        var ranges = (fileBlames[i] || []).map(BlameRange);

        ranges.sort(function(a, b) {
          return a.age - b.age;
        });

        var eligibleBlames = ranges.filter(function(range) {
          return isEligibleReviewer(range.login);
        });

        var recentBlames = eligibleBlames.slice(
          0,
          Math.ceil(eligibleBlames.length * 0.75)
        );

        var file = {
          authors: {},
          lines: 0
        };

        recentBlames.forEach(function(range) {
          var linesChanged = range.count;
          var author = range.login;

          if (!authorsLinesChanged[author]) {
            authorsLinesChanged[author] = 0;
          }

          if (!file.authors[author]) {
            file.authors[author] = 0;
          }

          authorsLinesChanged[author] += linesChanged;
          file.authors[author] += linesChanged;
          file.lines += linesChanged;
        });

        filesWithOwnership.push(file);
      }

      var reviewersByOwnership = [];

      filesWithOwnership.forEach(function (file) {
        Object.keys(file.authors).forEach(function (author) {
          if (!authorOwnership[author]) {
            authorOwnership[author] = [];
          }

          authorOwnership[author].push(Number((file.authors[author] / file.lines).toFixed(3)));
        });
      });

      uniqueAuthors = Object.keys(authorOwnership).length;

      Object.keys(authorOwnership).forEach(function (author) {
        var ownershipPercentages = authorOwnership[author];
        var averageOwnership = ownershipPercentages.reduce(function (sum, ownership) {
          return sum + ownership;
        }, 0) / ownershipPercentages.length;

        reviewersByOwnership.push({
          login: author,
          count: authorsLinesChanged[author],
          source: 'blame',
          ownership: Number(averageOwnership.toFixed(3))
        })
      });

      reviewersByOwnership.sort(function(a, b) {
        return b.ownership - a.ownership;
      });

      return assignedReviewers
        .concat(reviewersByOwnership)
        .slice(0, maxReviewersAssignable);
    })
    .then(function(reviewers) {
      var fallbackReviewers = [];
      var randomReviewers = [];

      if (
        uniqueAuthors < minAuthorsOfChangedFiles &&
        reviewers.length >= minReviewersAssignable &&
        reviewers.length
      ) {
        //unassign one random reviewer if there are already enough reviewers
        reviewers = reviewers.slice(0, maxReviewersAssignable);
        var excludedReviewerIndex = Math.floor(
          Math.random() * reviewers.length
        );
        excludedReviewers[reviewers[excludedReviewerIndex].login] = true;
        reviewers[excludedReviewerIndex] = null;
        reviewers = reviewers.filter(Boolean);
      }

      reviewers.forEach(function(reviewer) {
        selectedReviewers[reviewer.login] = true;
      });

      if (
        reviewers.length < minReviewersAssignable &&
        config.assignMinReviewersRandomly
      ) {
        Object.keys(reviewPathFallbacks || {})
          .forEach(function(pattern) {
            var matchingFiles = files.filter(function(file) {
              return minimatch(file.filename, pattern, {
                dot: true,
                matchBase: true
              });
            });

            matchingFiles.forEach(function() {
              var fallbackAuthors = reviewPathFallbacks[pattern];

              fallbackAuthors.forEach(function(author) {
                if (!isEligibleReviewer(author)) {
                  return;
                }

                fallbackReviewers.push({
                  login: author,
                  count: 0,
                  source: 'fallback'
                });

                selectedReviewers[author] = true;
              });
            });
          });

        shuffle.knuthShuffle(fallbackReviewers);
        reviewers = reviewers.concat(
          fallbackReviewers.slice(0, minReviewersAssignable - reviewers.length)
        );
      }

      if (
        reviewers.length < minReviewersAssignable &&
        config.assignMinReviewersRandomly
      ) {
        Object.keys(config.reviewers).forEach(function(author) {
          if (!isEligibleReviewer(author)) {
            return;
          }

          randomReviewers.push({
            login: author,
            count: 0,
            source: 'random'
          });

          selectedReviewers[author] = true;
        });

        shuffle.knuthShuffle(randomReviewers);
        reviewers = reviewers.concat(
          randomReviewers.slice(0, minReviewersAssignable - reviewers.length)
        );
      }

      return reviewers;
    })
    .then(function(reviewers) {
      return reviewers.map(function(reviewer) {
        reviewer.notify = config.reviewers[reviewer.login];
        return reviewer;
      });
    });
};
