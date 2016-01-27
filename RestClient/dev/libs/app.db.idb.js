'use strict';
/*******************************************************************************
 * Copyright 2012 Pawel Psztyc
 * 
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 * 
 * http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 ******************************************************************************/

/* global Dexie, chrome, HAR, HistoryUrlObject, HistorySocketObject, ProjectObject, 
ServerExportedObject, RequestObject */

/**
 * Advanced Rest Client namespace
 *
 * @namespace
 */
var arc = arc || {};
/**
 * ARC app's namespace
 *
 * @namespace
 */
arc.app = arc.app || {};
/**
 * A namespace for the database scripts.
 *
 * @namespace
 */
arc.app.db = arc.app.db || {};

/**
 * A namespace for IndexedDB scripts.
 *
 * @namespace
 */
arc.app.db.idb = {};
/**
 * A flag to be set to true if the datastore has been upgraded from WebSQL successfully.
 * This flag will be used to speed up database open operation.
 * 
 * @type {Boolean}
 */
arc.app.db.idb.upgraded = false;
/**
 * Open the database.
 *
 * @returns {Dexie.Promise} The promise when ready.
 */
arc.app.db.idb.open = function() {
  return new Dexie.Promise(function(resolve, reject) {
    var db = new Dexie('arc');
    db.version(1)
      .stores({
        headers: '&[key+type],key,type',
        statuses: '&key',
        historyUrls: '&url',
        historySockets: '&url',
        requestObject: '++id,url,method,[url+method],oldId',
        driveObjects: '[driveId+requestId],driveId,requestId',
        serverExportObjects: '[serverId+requestId],serverId,requestId,oldId',
        projectObjects: '++id,*requestIds,oldId'
      });
    db.projectObjects.mapToClass(ProjectObject);
    db.serverExportObjects.mapToClass(ServerExportedObject);
    db.driveObjects.mapToClass(DriveObject);
    db.requestObject.mapToClass(RequestObject);
    db.historySockets.mapToClass(HistorySocketObject);
    db.historyUrls.mapToClass(HistoryUrlObject);
    db.statuses.mapToClass(HttpStatusObject);
    db.headers.mapToClass(HttpHeaderObject);

    db.on('error', function(error) {
      console.error('IndexedDB global error', error);
    });
    db.on('populate', function() {
      return arc.app.db.idb.downloadDefinitions()
      .catch(function() {
        console.warn('Definitions wasn\'t there. skipping definitions installation.');
        return Dexie.Promise.resolve();
      })
      .then(function(defs) {
        if (!defs) {
          return Dexie.Promise.resolve();
        }
        return db.transaction('rw', db.statuses, db.headers, function() {
          let promises = [];

          let codes = defs.codes;
          defs.requests.forEach((item) => item.type = 'request');
          defs.responses.forEach((item) => item.type = 'response');
          let headers = defs.requests.concat(defs.responses);
          codes.forEach(function(item) {
            promises.push(db.statuses.add(item));
          });
          headers.forEach(function(item) {
            promises.push(db.headers.add(item));
          });

          return Dexie.Promise.all(promises);
        });
      })
      .then(function() {
        console.log('The database has been populated with data.');
      });
    });
    db.on('ready', function() {
      if (arc.app.db.idb.upgraded) {
        return;
      }
      arc.app.db.idb._db = db;
      arc.app.db.idb.appVer = chrome.runtime.getManifest ? chrome.runtime.getManifest()
        .version : 'tests case';
      return new Dexie.Promise(function(resolve) {
          console.info('Checking if upgrade is needed.');
          let upgrade = {
            upgraded: {
              indexeddb: false
            }
          };
          if (!chrome.storage) { //tests
            arc.app.db.idb.upgraded = true;
            resolve(false);
            return;
          }
          chrome.storage.local.get(upgrade, (upgrade) => {
            if (upgrade.upgraded.indexeddb) {
              arc.app.db._adapter = 'indexeddb';
              arc.app.db.idb.upgraded = true;
            }
            resolve(upgrade.upgraded.indexeddb);
          });
        })
        .then(arc.app.db.idb._getSQLdata)
        .then(arc.app.db.idb._converSqlIdb)
        .then(arc.app.db.idb._storeUpgrade)
        .then(function(result) {
          if (result === null) {
            return;
          }
          console.info('Database has been upgraded from WebSQL to IndexedDB.');
          arc.app.db._adapter = 'indexeddb';
          let upgrade = {
            upgraded: {
              indexeddb: true
            }
          };
          arc.app.db.idb.upgraded = true;
          if (chrome.storage) { //tests
            chrome.storage.local.set(upgrade, () => {
              console.info('Upgrade finished.');
            });
          } else {
            console.info('Upgrade finished.');
          }
        });
    });

    db.open()
      .then(function() {
        resolve(db);
      })
      .catch(function(error) {
        reject(error);
      });
  });
};
arc.app.db.idb.downloadDefinitions = function() {
  return fetch('/assets/definitions.json')
    .then(function(response) {
      return response.json();
    });
};
/**
 * This function is responsible for upgrading app's storage
 * from WebSQL to IndewxedDB.
 */
arc.app.db.idb._upgradeWebSQL = function() {
  return new Dexie.Promise(function(resolve, reject) {
    if (!arc.app.db.websql) {
      resolve();
      reject();
      return;
    }

    return Dexie.Promise.all([
      arc.app.db.idb._upgradeWebSLurlHistory(),
      arc.app.db.idb._upgradeWebSLSocketUrlHistory()
    ]);

  });
};
/**
 * Get all WebSQL data.
 *
 * @param {Boolean} dontUpgrade Used in promise chain. Don't upgrade it IndexedDB has been 
 * already upgraded
 */
arc.app.db.idb._getSQLdata = function(dontUpgrade) {
  if (dontUpgrade) {
    return null;
  }
  const data = {};
  return new Dexie.Promise(function(resolve, reject) {
    arc.app.db.websql.open()
      .then(function(db) {
        db.transaction(function(tx) {
          let sql = 'SELECT * FROM urls WHERE 1';
          tx.executeSql(sql, [], (tx, result) => {
            data.urls = Array.from(result.rows);
            sql = 'SELECT * FROM websocket_data WHERE 1';
            tx.executeSql(sql, [], (tx, result) => {
              data.websocketData = Array.from(result.rows);
              sql = 'SELECT * FROM history WHERE 1';
              tx.executeSql(sql, [], (tx, result) => {
                data.history = Array.from(result.rows);
                sql = 'SELECT * FROM projects WHERE 1';
                tx.executeSql(sql, [], (tx, result) => {
                  data.projects = Array.from(result.rows);
                  sql = 'SELECT * FROM request_data WHERE 1';
                  tx.executeSql(sql, [], (tx, result) => {
                    data.requestData = Array.from(result.rows);
                    sql = 'SELECT * FROM exported WHERE 1';
                    tx.executeSql(sql, [], (tx, result) => {
                      data.exported = Array.from(result.rows);
                      resolve(data);
                    }, (tx, error) => reject(error));
                  }, (tx, error) => reject(error));
                }, (tx, error) => reject(error));
              }, (tx, error) => reject(error));
            }, (tx, error) => reject(error));
          }, (tx, error) => reject(error));
        });
      });
  });
};
/**
 * Creates key for a RequestObject. It can be used inside HAR object to identify the request.
 * The main key is a combination of [HTTP METHOD]:[URL]
 *
 * @param {String} method A HTTP method
 * @param {String} url An URL of the request.
 * @return {String} a key for the Request object
 */
arc.app.db.createRequestKey = function(method, url) {
  var args = Array.from(arguments);
  if (args.length !== 2) {
    throw new Error('Number of arguments requires is 2 but ' + args.length +
      ' has been provided');
  }
  return method + ':' + url;
};
/**
 * Convert all data from WebSQL structure to the IndexedDB structure.
 */
arc.app.db.idb._converSqlIdb = function(data) {
  if (!data) {
    return null;
  }
  const requests = [];
  const urlHistory = [];
  const socketHistory = [];
  const exportedSize = data.exported.length;
  data.requestData.forEach((item) => {
    let obj = arc.app.db.idb._createHARfromSql.call(this, item);
    obj.type = 'saved';
    obj.oldId = item.id;
    //just for upgrade, to be removed before save. 
    if (item.project) {
      obj.project = item.project;
    }
    for (let i = 0; i < exportedSize; i++) {
      /* jscs: disable */
      if (data.exported[i].reference_id === item.id) {
        /* jscs: enable */
        //just for upgrade, to be removed before save. 
        obj.exported = i;
        break;
      }
    }
    requests.push(obj);
  });
  data.history.forEach((item) => {
    let obj = arc.app.db.idb._createHARfromSql.call(this, item);
    obj.oldId = item.id;
    requests.push(obj);
  });
  data.urls.forEach((item) => {
    let obj = new HistoryUrlObject({
      url: item.url,
      time: item.time,
    });
    urlHistory.push(obj);
  });
  data.websocketData.forEach((item) => {
    let obj = new HistorySocketObject({
      url: item.url,
      time: item.time,
    });
    socketHistory.push(obj);
  });

  return {
    indexeddb: {
      requests: requests,
      urlHistory: urlHistory,
      socketHistory: socketHistory
    },
    websql: data
  };
};
/**
 * Store upgraded from webSQL storage data in IndexedDb storage.
 */
arc.app.db.idb._storeUpgrade = function(data) {
  if (!data) {
    return null;
  }
  let db = arc.app.db.idb._db;
  console.info('Upgrading webSQL to IndexedDb');
  return db.transaction('rw', db.historyUrls, db.historySockets, db.requestObject,
    db.serverExportObjects, db.projectObjects,
    function() {
      console.info('Entered transaction. Ready to save data.');
      console.info('Inserting URL history');
      data.indexeddb.urlHistory.forEach((item) => {
        db.historyUrls.put(item);
      });
      console.info('Inserting Socket URL history');
      data.indexeddb.socketHistory.forEach((item) => {
        db.historySockets.put(item);
      });
      const projects = {};
      const exported = [];
      let promises = [];

      let insertRequest = (db, item) => {
        let referencedProjectId = item.project;
        let referencedExported = item.exported;
        delete item.project;
        delete item.exported;
        return db.requestObject.add(item)
          .then(function(requestId) {
            if (referencedProjectId) {
              if (!(referencedProjectId in projects)) {
                let _projects = data.websql.projects.filter(
                  (project) => project.id === referencedProjectId);
                if (_projects.length === 1) {
                  let project = new ProjectObject({
                    time: _projects[0].time,
                    name: _projects[0].name,
                    requestIds: [requestId],
                    oldId: _projects[0].id
                  });
                  projects[referencedProjectId] = project;
                } else if (_projects.length > 1) {
                  console.warn('Projects filtered array has more than one element ' +
                    'and it should not happen.');
                }
              } else {
                projects[referencedProjectId].addRequest(requestId);
              }
            }
            if (referencedExported) {
              let exportData = data.websql.exported[referencedExported];
              let exportObject = new ServerExportedObject({
                serverId: exportData.gaeKey,
                requestId: requestId,
                oldId: exportData.id
              });
              exported.push(exportObject);
            }
          });
      };

      console.info('Inserting requests');
      data.indexeddb.requests.forEach((item) => {
        promises.push(insertRequest(db, item));
      });

      return Dexie.Promise.all(promises)
        .then(() => {
          console.info('Exported items to be inserted: %d, projects items to be inserted: %d',
            exported.length, Object.keys(projects)
            .length);
          if (Object.keys(projects)
            .length > 0) {
            console.info('Inserting projects');
            Object.keys(projects)
              .forEach((projectKey) => {
                db.projectObjects.add(projects[projectKey]);
              });
          }
          if (exported.length > 0) {
            console.info('Inserting exported');
            exported.forEach((item) => {
              db.serverExportObjects.add(item);
            });
          }
        });
    });
};
/**
 * Create a RequestObject from the SQL data
 */
arc.app.db.idb._createHARfromSql = function(item) {
  var creator = new HAR.Creator({
    name: 'Advanced REST client',
    version: arc.app.db.idb.appVer,
    comment: 'Created during WebSQL update to IndexedDB'
  });
  var browser = new HAR.Browser({
    name: 'Chrome',
    version: 'unknown'
  });
  var log = new HAR.Log({
    'comment': 'Imported from WebSQL implementation',
    'version': 1.2,
    'creator': creator,
    'browser': browser
  });
  var requestHeaders = arc.app.headers.toJSON(item.headers);
  var request = new HAR.Request({
    url: item.url,
    httpVersion: 'HTTP/1.1',
    method: item.method
  });
  if (['GET', 'HEAD'].indexOf(item.method) === -1) {
    //Do not pass encoding for not-payload requests
    arc.app.headers._oldCombine(requestHeaders, item.encoding);
    var contentType = arc.app.headers.getContentType(requestHeaders) ||
      'application/x-www-form-urlencoded';
    var post = new HAR.PostData({
      mimeType: contentType,
      text: item.payload
    });
    request.postData = post;
  }
  request.headers = requestHeaders;
  var page = new HAR.Page({
    id: arc.app.db.createRequestKey(item.method, item.url),
    title: item.name,
    startedDateTime: new Date(item.time),
    pageTimings: {}
  });
  var entry = new HAR.Entry({
    startedDateTime: new Date(item.time),
    request: request,
    response: {
      status: '0',
      statusText: 'No response'
    }
  });
  entry.setPage(page);
  log.addPage(page);
  log.addEntry(entry, page.id);

  var obj = new RequestObject({
    'har': log,
    'url': item.url,
    'method': item.method,
    'type': 'history'
  });
  return obj;
};
/**
 * Updgrade URL's history.
 */
arc.app.db.idb._upgradeWebSLurlHistory = function() {
  return new Dexie.Promise(function(resolve, reject) {
    arc.app.db.websql.open()
      .then(function(db) {
        db.transaction(function(tx) {
          let sql = 'SELECT * FROM urls WHERE 1';
          tx.executeSql(sql, [], (tx, result) => {
            if (result.rows.length === 0) {
              resolve();
              return;
            }
            let data = Array.from(result.rows);
            arc.app.db.idb.open()
              .then(function(db) {
                db.transaction('rw', db.historyUrls, function(historyUrls) {
                    data.forEach(function(item) {
                      historyUrls.add(item);
                    });
                  })
                  .catch(reject)
                  .finally(function() {
                    db.close();
                    resolve();
                  });
              })
              .catch((e) => reject(e));
          }, function(tx, error) {
            reject(error);
          });
        });
      })
      .catch((e) => reject(e));
  });
};
/**
 * Updgrade socket URL's history.
 */
arc.app.db.idb._upgradeWebSLSocketUrlHistory = function() {
  return new Dexie.Promise(function(resolve, reject) {
    arc.app.db.websql.open()
      .then(function(db) {
        db.transaction(function(tx) {
          let sql = 'SELECT * FROM websocket_data WHERE 1';
          tx.executeSql(sql, [], (tx, result) => {
            if (result.rows.length === 0) {
              resolve();
              return;
            }
            let data = Array.from(result.rows);
            arc.app.db.idb.open()
              .then(function(db) {
                db.transaction('rw', db.historySockets, function(historySockets) {
                    data.forEach(function(item) {
                      historySockets.add(item);
                    });
                  })
                  .catch(reject)
                  .finally(function() {
                    db.close();
                    resolve();
                  });
              })
              .catch((e) => reject(e));
          }, function(tx, error) {
            reject(error);
          });
        });
      })
      .catch((e) => reject(e));
  });
};
/**
 * Get status code definition by it's code.
 *
 * @param {Number} code HTTP status code to look for
 * @return {Promise} Fulfilled promise will result with a {@link
 * HttpStatusObject}
 */
arc.app.db.idb.getStatusCode = function(code) {
  return new Promise(function(resolve, reject) {
    arc.app.db.idb.open()
      .then(function(db) {
        db.statuses.get(code)
          .then(resolve)
          .catch(reject)
          .finally(function() {
            db.close();
          });
      })
      .catch((e) => reject(e));
  });
};
/**
 * Get header from the storage by it's name and type
 * 
 * @param {String} name A header name to look for
 * @param {String} type Either `request` or `response`
 * @return {Promise} Fulfilled promise will result with a {@link
 * HttpHeaderObject}
 */
arc.app.db.idb.getHeaderByName = function(name, type) {
  return new Promise(function(resolve, reject) {
    arc.app.db.idb.open()
      .then(function(db) {
        let result = null;
        db.headers.where('[key+type]')
          .equals([name, type])
          .each(function(header) {
            result = header;
          })
          .catch(reject)
          .finally(function() {
            db.close();
            resolve(result);
          });
      })
      .catch((e) => reject(e));
  });
};
/**
 * Get list of headers by name and type
 *
 * @param {String} name A header name to look for
 * @param {String} type Either `request` or `response`
 * @return {Promise} Fulfilled promise will result with list of {@link
 * HttpHeaderObject}
 */
arc.app.db.idb.getHeadersByName = function(name, type) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.headers.where('key')
        .startsWithIgnoreCase(name)
        .and((item) => item.type === type)
        .sortBy('key')
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Add new / update URL history value.
 *
 * @param {String} url The user to add
 * @param {Date|Number} time Time of creation.
 * @return {Promise} Fulfilled promise will result with id of created {@link
 * HistoryUrlObject}
 */
arc.app.db.idb.putUrlHistory = function(url, time) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.transaction('rw', db.historyUrls, function(historyUrls) {
          return historyUrls.put({
            'url': url,
            'time': time
          });
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Get url values from the `urls` table matching `query`. This function will
 * return all entries that starts with `query`
 *
 * @param {String} query A search string to look for.
 * @return {Promise} Fulfilled promise will result with list of {@link
 * HistoryUrlObject}
 */
arc.app.db.idb.getHistoryUrls = function(query) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.historyUrls.where('url')
        .startsWithIgnoreCase(query)
        .sortBy('url')
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Add new project data to the `projects` table with existing RequestObject.
 *
 * @param {String} name
 * @param {String} time
 * @param {Number} requestId Optional. Request id which the project has been
 * created with.
 * @return {Promise} Fulfilled promise will result with id of created {@link
 * ProjectObject}
 */
arc.app.db.idb.addProject = function(name, time, requestId) {
  return arc.app.db.idb.open()
    .then(function(db) {
      let project = new ProjectObject({
        'time': time,
        'name': name,
        'requestIds': requestId ? [requestId] : []
      });
      return db.transaction('rw', db.projectObjects, function(projectObjects) {
          return projectObjects.put(project);
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Perform an import (from file / server) with requests and related projects.
 * All requests passed as an argument will be inserted to the store and
 * project will reference them. The `project` can be restored ProjectObject.
 * In this scenario project will be updated in the store instead of insert. So
 * this function can be use just to insert new request to existing project.
 *
 * A Promise results with new project key (if this is new project) or number
 * of updated records (0 or 1 in this case).
 *
 * @param {ProjectObject} project A project to be inserted into the database.
 * @param {Array<RequestObject>} requests A list of requests to be inserted
 * into the database.
 *
 * @return {Promise} Fulfilled promise will result with ID of newly created
 * {@link ProjectObject}.
 */
arc.app.db.idb.importProjectWithRequests = function(project, requests) {
  //WebSQL ID.
  const projectOldId = project.oldId || project.id || null;
  const requestsArray = []; //array of RequestObject
  if (!(project instanceof ProjectObject)) {
    project = new ProjectObject({
      'time': project.time,
      'name': project.name,
      'requestIds': project.requestIds || []
    });
  }
  if (projectOldId) {
    project.oldId = projectOldId;
  }
  requests.forEach((item) => {
    let r = arc.app.db.idb._createHARfromSql.call(this, item);
    r.type = 'saved';
    if (item.oldId) {
      r.oldId = item.oldId;
    } else if (!item.type && item.id) {
      r.oldId = item.id;
    }
    requestsArray.push(r);
  });
  // first insert request to obtain their ids and then insert project
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.transaction('rw', db.projectObjects, db.requestObject, function() {
        let promises = [];
        let insertRequest = (db, item) => {
          return db.requestObject.add(item)
            .catch(function(e) {
              console.error('Error saving the request.', e);
              throw e;
            })
            .then(function(requestId) {
              project.addRequest(requestId);
            });
        };
        requestsArray.forEach((item) => {
          promises.push(insertRequest(db, item));
        });
        return Dexie.Promise.all(promises)
          .then(() => {
            return db.projectObjects.put(project);
          })
          .finally(function() {
            db.close();
          });
      });
    });
};
/**
 * Get project data from the store.
 * This function will result null if entry for given [id] is not found.
 *
 * @param {Number} id An ID of the project
 * @return {Promise} Fulfilled will result with {@link ProjectObject}.
 */
arc.app.db.idb.getProjectLegacy = function(id) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.projectObjects.where('oldId').equals(id).toArray()
        .then(function(objs) {
          return (objs && objs.length) ? objs[0] : null;
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Update project data in `projects` table.
 * This function will change and will be operating on ProjectObject only.
 *
 * Fulfilled promise wil result with database ID.
 *
 * @param {Number} id the ID of the project
 * @param {String} name Name to be updated
 * @param {Number} time Optional. Change time. Current time will be used if empty.
 *
 * @return {Promise} Fulfilled when {@link ProjectObject} has been updated.
 */
arc.app.db.idb.updateProjectLegacy = function(id, name, time) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.projectObjects.where('oldId').equals(id).toArray()
        .then(function(objs) {
          let obj = (objs && objs.length) ? objs[0] : null;
          if (!obj) {
            throw new Error('No project found.');
          }
          obj.name = name;
          obj.time = time || Date.now();
          return db.transaction('rw', db.projectObjects, function() {
            return db.projectObjects.put(obj);
          });
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * List entries from the `projects` table.
 * This function will result with empty array if projects table is empty.
 *
 * @return {Promise} Fulfilled promise will result with list of {@link ProjectObject}s
 */
arc.app.db.idb.listProjects = function() {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.projectObjects.toArray()
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Get project data from the store.
 * This function will result null if entry for given [id] is not found.
 *
 * @param {Number} legacyId An ID of the project
 */
arc.app.db.idb.deleteProjectLegacy = function(legacyId) {
  var _projectId;
  return arc.app.db.idb.getProjectLegacy(legacyId)
    .then(function(project) {
      if (!project) {
        throw new Error('Project not found in legacy list');
      }
      _projectId = project.id;
    })
    .then(arc.app.db.idb.open)
    .then(function(db) {
      return db.transaction('rw', db.projectObjects, function() {
          return db.projectObjects.delete(_projectId);
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Insert array of request in one operation.
 *
 * @param {Array<RequestObject>} requests A list of request to be inserted.
 * @return {Promise} Fulfilled promise will result with IDs of inserted {@link RequestObject}s
 */
arc.app.db.idb.importRequests = function(requests) {
  const requestsArray = []; //array of RequestObject
  return arc.app.db.idb.open()
    .then(function(db) {
      requests.forEach((item) => {
        let r = arc.app.db.idb._createHARfromSql.call(this, item);
        r.type = 'saved';
        requestsArray.push(r);
      });
      return db.transaction('rw', db.requestObject, function(requestObject) {
          let promises = [];
          requestsArray.forEach((item) => {
            promises.push(requestObject.add(item));
          });
          return Dexie.Promise.all(promises);
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Read the request from the datastore.
 *
 * @param {Number} id Request ID.
 * @return {Promise} Fulfilled promise will result a {@link RequestObject}
 */
arc.app.db.idb.getRequest = function(id) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.requestObject.get(id)
        //.then((request) => request ? new RequestObject(request) : null)
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Get request referenced with project represented by projectId.
 *
 * @param {Number} projectId ID of the project.
 * @return {Promise} Fulfilled promise will result with list of {@link RequestObject}
 */
arc.app.db.idb.getProjectRequests = function(projectId) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.projectObjects.get(projectId)
        .then(function(project) {
          if (!project || !project.requestIds || project.requestIds.length === 0) {
            return [];
          }
          return db.requestObject.where(':id')
            .anyOf(project.requestIds)
            .toArray();
        })
        .then(function(requests) {
          let result = [];
          requests.forEach((item) => {
            result.push(new RequestObject(item));
          });
          return result;
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Delete project with referenced requests.
 *
 * @param {Number} projectId A project ID to be removed.
 */
arc.app.db.idb.deleteProjectRecursive = function(projectId) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.projectObjects.get(projectId)
        .then(function(project) {
          let requests = project.requestIds;
          return db.transaction('rw', db.requestObject, db.projectObjects, function() {
            let promises = [];
            promises.push(db.projectObjects.delete(projectId));
            requests.forEach((requestId) => {
              promises.push(db.requestObject.delete(requestId));
            });
            return Dexie.Promise.all(promises);
          });
        })
        .finally(function() {
          db.close();
        });
    });
};
arc.app.db.idb.deleteProjectRecursiveLegacy = function(legacyProjectId) {
  var _project;
  return arc.app.db.idb.getProjectLegacy(legacyProjectId)
    .then(function(project) {
      if (!project) {
        throw new Error('No project found.');
      }
      _project = project;
    })
    .then(arc.app.db.idb.open)
    .then(function(db) {
      let requests = _project.requestIds;
      return db.transaction('rw', db.requestObject, db.projectObjects, function() {
          let promises = [];
          promises.push(db.projectObjects.delete(_project.id));
          requests.forEach((requestId) => {
            promises.push(db.requestObject.delete(requestId));
          });
          return Dexie.Promise.all(promises);
        })
        .finally(function() {
          db.close();
        });
    });
};
/**
 * Get history items by it's URL and HTTP method values.
 *
 * @param {String} url And URL to query for
 * @param {String} method A HTTP method to query for.
 */
arc.app.db.idb.getRequestObjectsQueryArrayKey = function(url, method) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.requestObject.where('[url+method]').equals(url + ':' + method)
      .finally(function() {
        db.close();
      });
    });
};
/**
 * Get a request object by it's legacy ID.
 *
 * @param {Number} legacyId An id of the referenced request form WebSQL
 * @return {Promise} When fulfilled the promise result with Array of items or 
 * empty array of there were no entries.
 */
arc.app.db.idb.getRequestObjectsByLegacyId = function(legacyId) {
  return arc.app.db.idb.open()
    .then(function(db) {
      return db.requestObject
        .where('oldId')
        .equals(legacyId)
        .toArray()
        .finally(function() {
          db.close();
        });
    });
};
// @if NODE_ENV='debug'
/**
 * In dev mode there is no direct connection to the database initialized in the background page.
 * This function must be called in Development environment to initialize IndexedDb.
 */
arc.app.db.idb.initDev = function() {
  if (location.hostname !== '127.0.0.1' || location.port !== '8888') {
    return;
  }
  arc.app.db.idb.open()
    .then(function() {
      console.log('%cDEVMODE::IndexedDB has been initialized', 'color: #33691E');
    })
    .catch((e) => console.error('DEVMODE::Error initializing the IDB database', e));
};
arc.app.db.idb.initDev();
// @endif
