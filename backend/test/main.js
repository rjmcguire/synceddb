var WebSocket = require('ws');
var assert = require('assert');

var Server = require('../server');
var MemoryPersistence = require('../../persistence/memory');

var server = new Server({
  port: 8080,
  store: new MemoryPersistence(),
});

function socketConversation(ws, funcs) {
  var r = funcs[0]();
  if (r) ws.send(JSON.stringify(r));
  var next = 1;
  ws.onmessage = function(msg) {
    var r = funcs[next++](JSON.parse(msg.data));
    if (r) ws.send(JSON.stringify(r));
  };
}

describe('Backend', function() {
  var ws = new WebSocket('ws://localhost:8080');
  beforeEach(function() {
  });
  afterEach(function(done) {
    server.resetHandlers();
    ws.send(JSON.stringify({type: 'reset'}));
    ws.onmessage = function() {
      done();
    };
  });
  it('get zero changes initially', function(done) {
    ws.send(JSON.stringify({
      type: 'get-changes',
      since: null,
      storeName: 'animals',
      clientId: 'foo',
    }));
    ws.onmessage = function(msg) {
      var data = JSON.parse(msg.data);
      assert.equal(data.type, 'sending-changes');
      assert.equal(data.nrOfRecordsToSync, 0);
      done();
    };
  });
  it('sends created records on request', function(done) {
    var data1, data2;
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        data1 = data;
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Thumper', key: 2},
        };
      },
      function(data) {
        data2 = data;
        if (data1.newKey) {
          assert.notEqual(data1.newKey, data2.newKey);
        }
        return {
          type: 'get-changes',
          since: null,
          storeName: 'animals',
          clientId: 'otherfoo',
        };
      },
      function(data) {
        assert.equal(data.nrOfRecordsToSync, 2);
      },
      function(data) {
        assert.equal(data.record.name, 'Stampe');
      },
      function(data) {
        assert.equal(data.record.name, 'Thumper');
        done();
      }
    ]);
  });
  it('sends timestamps in ok response', function(done) {
    var data1, data2;
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        assert.notEqual(data.timestamp, undefined);
        done();
      }
    ]);
  });
  it('only sends changes after timestamp', function(done) {
    var firstTimestamp;
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        return {
          type: 'get-changes',
          since: null,
          storeName: 'animals',
          clientId: 'otherfoo',
        };
      },
      function(data) {
        assert.equal(data.nrOfRecordsToSync, 1);
      },
      function(data) {
        assert.equal(data.record.name, 'Stampe');
        firstTimestamp = data.timestamp;
        assert.equal(data.record.name, 'Stampe');
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Smask', key: 2},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        return {
          type: 'get-changes',
          since: firstTimestamp,
          storeName: 'animals',
          clientId: 'otherfoo',
        };
      },
      function(data) {
        assert.equal(data.nrOfRecordsToSync, 1);
      },
      function(data) {
        assert.equal(data.record.name, 'Smask');
        done();
      }
    ]);
  });
  it('only sends changes from requested store', function(done) {
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        data1 = data;
        return {
          type: 'create',
          storeName: 'roads',
          clientId: 'foo',
          record: {length: 100, key: 2},
        };
      },
      function(data) {
        return {
          type: 'get-changes',
          since: null,
          storeName: 'roads',
          clientId: 'otherfoo',
        };
      },
      function(data) {
        assert.equal(data.nrOfRecordsToSync, 1);
      },
      function(data) {
        assert.equal(data.record.length, 100);
        return {
          type: 'get-changes',
          since: null,
          storeName: 'animals',
          clientId: 'otherfoo',
        };
      },
      function(data) {
        assert.equal(data.nrOfRecordsToSync, 1);
      },
      function(data) {
        assert.equal(data.record.name, 'Stampe');
        done();
      },
    ]);
  });
  it('calls custom handler when client connects', function(done) {
    server.handlers.connect = function(clientData, store, msg, respond, broadcast) {
      assert.equal(msg.type, 'connect');
      done();
    };
    var newWs = new WebSocket('ws://localhost:8080');
  });
  it('calls custom create handler correctly', function(done) {
    var called = false;
    server.handlers['create'] = function(clientData, store, msg, respond, broadcast) {
      called = true;
      assert.equal(msg.type, 'create');
      assert.equal(typeof respond, 'function');
      assert.equal(typeof broadcast, 'function');
      Server.defaultHandlers['create'].apply(null, arguments);
    };
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        assert(called);
        done();
      }
    ]);
  });
  it('is possible for handlers to store data on connected clients', function(done) {
    var dataPersisted = false;
    server.handlers['create'] = function(clientData, store, msg, respond, broadcast) {
      if (!clientData.test) {
        clientData.test = 'foobar';
      } else {
        assert.equal(clientData.test, 'foobar');
        dataPersisted = true;
      }
      Server.defaultHandlers['create'].apply(null, arguments);
    };
    socketConversation(ws, [
      function() {
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        return {
          type: 'create',
          storeName: 'animals',
          clientId: 'foo',
          record: {name: 'Stampe', key: 1},
        };
      },
      function(data) {
        assert.equal(data.type, 'ok');
        assert(dataPersisted);
        done();
      }
    ]);
  });
  it('only publish changes after changes has been requested', function(done) {
    var ws2 = new WebSocket('ws://localhost:8080');
    var ws2MsgCount = 0, wsMsgCount = 0;
    ws.onmessage = function(msg) {
      wsMsgCount++;
      if (wsMsgCount === 1) {
        var data = JSON.parse(msg.data);
        assert.equal(data.type, 'sending-changes');
        assert.equal(data.nrOfRecordsToSync, 2);
      } else if (wsMsgCount === 3) {
        done();
      }
    };
    ws2.onmessage = function() {
      ws2MsgCount++;
      if (ws2MsgCount === 2) {
        assert.equal(wsMsgCount, 0);
        ws.send(JSON.stringify({
          type: 'get-changes',
          since: null,
          storeName: 'animals',
        }));
      }
    };
    ws2.onopen = function() {
      ws2.send(JSON.stringify({
        type: 'create',
        storeName: 'animals',
        record: {name: 'Stampe', key: 1},
      }));
      ws2.send(JSON.stringify({
        type: 'create',
        storeName: 'animals',
        record: {name: 'Thumper', key: 2},
      }));
    };
  });
});
