/* eslint arrow-parens: ["error", "as-needed"] */
/* eslint autoFixOnSave: 0 */
/* eslint no-trailing-spaces: 0 */
/* eslint object-curly-spacing: 0 */
/* eslint no-param-reassign: 0 */
/* eslint comma-dangle: 0 */
/* eslint no-underscore-dangle: 0 */
/* eslint no-unneeded-ternary: 0 */
/* eslint consistent-return: 0 */
/* eslint prefer-template: 0 */
/* eslint operator-linebreak: 0 */
/* eslint function-paren-newline: 0 */
/* eslint prefer-destructuring: 0 */
/* eslint arrow-body-style: 0 */

// Import packages
const dgram = require('dgram');
const net = require('net');
const {EventEmitter} = require('events');
const timeout = require('p-timeout');
const retry = require('retry');
const debug = require('debug')('TuyAPI');

// Helpers
const Cipher = require('./lib/cipher');
const Parser = require('./lib/message-parser');

// Gets all compatible devices on the network if no option is selected
// With options then it resolvesId and returns the id/ip if one is missing.
function resolveDevices(device, options) {
  // Create new listener
  const listener = dgram.createSocket('udp4');
  listener.bind(6666);
  const timeoutLength = (options === undefined ? 10000 : options.timeout * 1000);

  // Find IP for device
  return timeout(new Promise((resolve, reject) => { // Timeout
    listener.on('message', message => {
      debug('Received UDP message.');

      let dataRes;
      try {
        dataRes = Parser.parse(message);
      } catch (error) {
        debug(error);
        return;
      }
      debug('UDP data:');
      debug(dataRes.data);
      const thisId = dataRes.data.gwId;
      const thisIp = dataRes.data.ip;
      if (options === undefined) {
        if (thisId in device) {
          // Cleanup
          listener.close();
          listener.removeAllListeners();
          resolve(true);
        } else {
          device[thisId] = dataRes.data;
        } 
      } else if ((device.id === thisId || device.ip === thisIp) && dataRes.data) {
        // Add IP
        device.ip = dataRes.data.ip;

        // Add ID
        device.id = dataRes.data.gwId;

        // Update gwID if required
        if (device.gwID === undefined) {
          device.gwID = dataRes.data.gwId;
        }

        // Change product key if neccessary
        device.productKey = dataRes.data.productKey;

        // Change protocol version if necessary
        device.version = dataRes.data.version;

        // Cleanup
        listener.close();
        listener.removeAllListeners();
        resolve(true);
      }
    });
    listener.on('error', err => reject(err));
  }), timeoutLength, () => {
    // Have to do this so we exit cleanly
    listener.close();
    listener.removeAllListeners();
    // eslint-disable-next-line max-len
    return Promise.reject(new Error('resolveIds() timed out. Is the device powered on and the ID correct?'));
  });
}
// Logic moved to resolveDevices
function resolveId(device, options) {
  debug(`Finding missing IP: ${device.ip} or Device ID: ${device.id}`);
  return resolveDevices(device, options);
}

let resolveIdQueue = Promise.resolve();

function serialResolveId(device, options) {
  const promise = resolveIdQueue.catch(() => {}).then(() => {
    return resolveId(device, options);
  });

  resolveIdQueue = promise;
  return promise;
}

let resolveDeviceQue = Promise.resolve();

function serialResolveDevices(devices) {
  this.devices = {};
  const promise = resolveDeviceQue.catch(() => {}).then(() => {
    return resolveDevices(devices);
  });
  resolveDeviceQue = promise;
  return promise;
}

function checkIfValidString(input) {
  if (input === undefined || typeof input !== typeof 'string' || input.length === 0) {
    return false;
  }

  return true;
}

/**
 * Represents a Tuya device.
 * @class
 * @param {Object} options
 * @param {String} [options.ip] IP of device
 * @param {Number} [options.port=6668] port of device
 * @param {String} options.id ID of device (also called `devId`)
 * @param {String} [options.gwID=''] gateway ID (not needed for most devices),
 * if omitted assumed to be the same as `options.id`
 * @param {String} options.key encryption key of device (also called `localKey`)
 * @param {String} options.productKey product key of device
 * @param {Number} [options.version=3.1] protocol version
 * @param {Boolean} [options.persistentConnection=false]
 * whether or not to use a persistent socket with heartbeat packets
 * @example
 * const tuya = new TuyaDevice({id: 'xxxxxxxxxxxxxxxxxxxx',
 *                              key: 'xxxxxxxxxxxxxxxx',
 *                              persistentConnection: true})
 */
class TuyaDevice extends EventEmitter {
  constructor(options) {
    super();

    this.device = options;

    // Defaults


    if (!(checkIfValidString(this.device.id) || checkIfValidString(this.device.ip))) {
      debug('No IP or ID Set');
      try {
        if (this.device.resolve === false) {
          throw new Error('No ID or IP set. Run with resolve: true to view device ids and ips');
        } else {
          this.resolveDevices().then(() => {
            if (this.device.resolve !== true) {
              throw new Error('No ID or IP set. Select device from above');
            }
          }).catch(err => {
            console.log(err);
          });
        }
      } catch (error) {
        console.log(error);
      }
    }

    if (!checkIfValidString(this.device.id)) {
      debug('ID is missing from device. Run resolveID() to get from IP');
    } else if (this.device.gwID === undefined) {
      this.device.gwID = this.device.id;
    }

    if (!checkIfValidString(this.device.ip)) {
      debug('IP is missing from device. Run resolveID() to get from ID');
    }

    if (checkIfValidString(this.device.key)) {
      // Create cipher from key
      this.device.cipher = new Cipher({
        key: this.device.key,
        version: this.device.version
      });
    } else {
      debug('Encryption key is missing. You will not be able to set device state');
    }

    if (this.device.port === undefined) {
      this.device.port = 6668;
    }

    if (this.device.version === undefined) {
      this.device.version = 3.1;
    }

    if (this.device.persistentConnection === undefined) {
      this.device.persistentConnection = false;
    }

    // Private variables

    // Socket connected state
    this._connected = false;

    this._responseTimeout = 5; // Seconds
    this._connectTimeout = 1; // Seconds
    this._pingPongPeriod = 10; // Seconds
    this._persistentConnectionStopped = true;
  }

  /**
   * Resolves ID stored in class to IP. If you didn't
   * pass an IP to the constructor, you must call
   * this before doing anything else.
   * @param {Object} [options]
   * @param {Number} [options.timeout=10]
   * how long, in seconds, to wait for device
   * to be resolved before timeout error is thrown
   * @example
   * tuya.resolveIds().then(() => console.log('ready!'))
   * @returns {Promise<Boolean>}
   * true if IP was found and device is ready to be used
   */
  resolveId(options) {
    // Set default options
    options = options ? options : {};

    if (options.timeout === undefined) {
      options.timeout = 10;
    }

    if (checkIfValidString(this.device.id) && checkIfValidString(this.device.ip)) {
      debug('No IPs or IDs to search for');
      return Promise.resolve(true);
    }

    return serialResolveId(this.device, options);
  }

  resolveDevices() {
    debug(`print before ${this.device}`);
    if (this.devices === undefined) {
      this.devices = {};
    }
    return new Promise((resolve, reject) => {
      serialResolveDevices(this.devices).then(async () => {
        debug(`devices ${JSON.stringify(this.devices)}`);
        const idKeys = Object.keys(this.devices);
        process.stdout.write('{ "devices": [ ');
         
        const getDevData = async (index, ids) => {
          const newId = ids[index];
          const newTuya = new TuyaDevice({
            id: newId,
            ip: this.devices[newId].ip,
          });
          const delayConst = await newTuya.get(JSON.parse('{ "schema": true }')).then(status => {
            debug(`Run :${newId} Status: ${JSON.stringify(status)}`);
            process.stdout.write(`\n{ "id": ${newId}, "broadcast": ${JSON.stringify(this.devices[newId])}, "schema": ${JSON.stringify(status)} },`);
            Promise.resolve();
            return status;
          }, reason => {
            console.log(reason.toString());
            Promise.reject();
            reject(reason.toString());
          });
          debug(`delay ${delayConst}`);
          index += 1;
          if (index < ids.length) {
            getDevData(index, ids);
          }
        };
        getDevData(0, idKeys);
      }, reason => {
        console.log(reason.toString());
        reject(reason.toString());
      });
    });
  }


  /**
   * @deprecated since v3.0.0. Will be removed in v4.0.0. Use resolveId() instead.
   */
  resolveIds(options) {
    // eslint-disable-next-line max-len
    console.warn('resolveIds() is deprecated since v3.0.0. Will be removed in v4.0.0. Use resolveId() instead.');
    return this.resolveId(options);
  }

  /**
   * Gets a device's current status.
   * Defaults to returning only the value of the first DPS index.
   * If `returnAsEvent = true`, all options are ignored and
   * all data returned from device is emitted as event.
   * @param {Object} [options]
   * @param {Boolean} [options.schema]
   * true to return entire schema of device
   * @param {Number} [options.dps=1]
   * DPS index to return
   * @param {Boolean} [options.returnAsEvent=false]
   * true to emit `data` event when result is returned, false
   * to return Promise
   * @example
   * // get all properties and emit event with data
   * tuya.get({returnAsEvent: true});
   * @example
   * // get first, default property from device
   * tuya.get().then(status => console.log(status))
   * @example
   * // get second property from device
   * tuya.get({dps: 2}).then(status => console.log(status))
   * @example
   * // get all available data from device
   * tuya.get({schema: true}).then(data => console.log(data))
   * @returns {Promise<Object>}
   * returns boolean if no options are provided, otherwise returns object of results
   */
  get(options) {
    // Set empty object as default
    options = options ? options : {};

    const payload = {
      gwId: this.device.gwID,
      devId: this.device.id
    };

    debug('Payload: ', payload);

    // Create byte buffer
    const buffer = Parser.encode({
      data: payload,
      commandByte: 10 // 0x0a
    });

    return new Promise((resolve, reject) => {
      this._send(buffer, 10, options.returnAsEvent).then(data => {
        if (options.returnAsEvent) {
          return resolve();
        }

        if (typeof data === 'string') {
          reject(data);
        } else if (options.schema === true) {
          resolve(data);
        } else if (options.dps) {
          resolve(data.dps[options.dps]);
        } else {
          resolve(data.dps['1']);
        }
      }).catch(error => {
        reject(error);
      });
    });
  }

  /**
   * Sets a property on a device.
   * @param {Object} options
   * @param {Number} [options.dps=1] DPS index to set
   * @param {*} [options.set] value to set
   * @param {Boolean} [options.multiple=false]
   * Whether or not multiple properties should be set with options.data
   * @param {Object} [options.data={}] Multiple properties to set at once. See above.
   * @example
   * // set default property
   * tuya.set({set: true}).then(() => console.log('device was changed'))
   * @example
   * // set custom property
   * tuya.set({dps: 2, set: true}).then(() => console.log('device was changed'))
   * @example
   * // set multiple properties
   * tuya.set({
   *           multiple: true,
   *           data: {
   *             '1': true,
   *             '2': 'white'
   *          }}).then(() => console.log('device was changed'))
   * @returns {Promise<Boolean>} - returns `true` if the command succeeded
   */
  set(options) {
    let dps = {};

    if (options.multiple === true) {
      dps = options.data;
    } else if (options.dps === undefined) {
      dps = {
        1: options.set
      };
    } else {
      dps = {
        [options.dps.toString()]: options.set
      };
    }

    const now = new Date();
    const timeStamp = (parseInt(now.getTime() / 1000, 10)).toString();

    const payload = {
      devId: this.device.id,
      gwId: this.device.gwID,
      uid: '',
      t: timeStamp,
      dps
    };

    debug('Payload:', this.device.ip);
    debug(payload);

    // Encrypt data
    const data = this.device.cipher.encrypt({
      data: JSON.stringify(payload)
    });

    // Create MD5 signature
    const md5 = this.device.cipher.md5('data=' + data +
      '||lpv=' + this.device.version +
      '||' + this.device.key);

    // Create byte buffer from hex data
    const thisData = Buffer.from(this.device.version + md5 + data);
    const buffer = Parser.encode({
      data: thisData,
      commandByte: 7 // 0x07
    });

    // Send request to change status
    return new Promise((resolve, reject) => {
      this._send(buffer, 7, false).then(() => {
        resolve(true);
      }).catch(error => {
        reject(error);
      });
    });
  }

  /**
   * Sends a query to a device. Helper
   * function that wraps ._sendUnwrapped()
   * in a retry operation.
   * @private
   * @param {String} ip IP of device
   * @param {Buffer} buffer buffer of data
   * @param {Boolean} returnAsEvent return result as event or as resolved promise
   * @returns {Promise<string>} returned data
   */
  _send(buffer, expectedResponseCommandByte, returnAsEvent) {
    if (typeof this.device.ip === 'undefined') {
      throw new TypeError('Device missing IP address.');
    }

    const operation = retry.operation({
      retries: 4,
      factor: 1.5
    });

    return new Promise((resolve, reject) => {
      operation.attempt(currentAttempt => {
        debug('Send attempt', currentAttempt);

        this._sendUnwrapped(buffer, expectedResponseCommandByte, returnAsEvent).then(
          (result, commandByte) => {
            resolve(result, commandByte);
          }).catch(error => {
          if (operation.retry(error)) {
            return;
          }

          reject(operation.mainError());
        });
      });
    });
  }

  /**
   * Sends a query to a device.
   * @private
   * @param {Buffer} buffer buffer of data
   * @param {Boolean} returnAsEvent return result as event or as resolved promise
   * @returns {Promise<string>} returned data
   */
  _sendUnwrapped(buffer, expectedResponseCommandByte, returnAsEvent) {
    debug('Sending this data:', buffer.toString('hex'));

    return new Promise((resolve, reject) => {
      if (!returnAsEvent) {
        this.dataResolver = (data, commandByte) => { // Delayed resolving of promise
          if (expectedResponseCommandByte !== commandByte) {
            reject(new Error('Returned command byte did not match expected byte.'));
          }

          if (this._sendTimeout) {
            clearTimeout(this._sendTimeout);
          }
          if (!this.device.persistentConnection) {
            this.disconnect(() => resolve(data, commandByte)); 
          }
        
          // resolve(data, commandByte);
          return true;
        };

        this.dataRejector = err => {
          if (this._sendTimeout) {
            clearTimeout(this._sendTimeout);
          }

          debug('Error event from socket.');

          // eslint-disable-next-line max-len
          err.message = 'Error communicating with device. Make sure nothing else is trying to control it or connected to it.';
          return reject(err);
        };
      }

      this.connect().then(() => {
        if (this.pingpongTimeout) {
          clearTimeout(this.pingpongTimeout);
          this.pingpongTimeout = null;
        }

        // Transmit data
        this.client.write(buffer);

        this._sendTimeout = setTimeout(() => {
          if (this.client) {
            this.client.destroy();
          }

          this.dataResolver = null;
          this.dataRejector = null;
          return reject(new Error('Timeout waiting for response'));
        }, this._responseTimeout * 1000);
        if (returnAsEvent) {
          resolve();
        }
      });
    });
  }

  /**
   * Sends a ping to the device
   * @private
   * @returns {Promise<string>} returned data
   */
  __sendPing() {
    debug('PING', this.device.ip, this.client ? this.client.destroyed : true);
    // Create byte buffer
    const buffer = Parser.encode({
      data: Buffer.allocUnsafe(0),
      commandByte: 9 // 0x09
    });
    debug('PingPong: ' + buffer.toString('hex'));

    this._sendUnwrapped(buffer, 9, true);
  }

  /**
   * Connects to the device, use to initally
   * open a socket when using a persistent connection.
   * @returns {Promise<Boolean>}
   * @emits TuyaDevice#connected
   * @emits TuyaDevice#disconnected
   * @emits TuyaDevice#data
   * @emits TuyaDevice#error
   */
  connect() {
    this._persistentConnectionStopped = false;
    if (typeof this.client === 'undefined') {
      debug('client undefined');
    } else {
      debug(`opening client it's state is ${JSON.stringify(this.client)}`);
    }
    
    if (!this.client) {
      debug('Creating new socket');
      if (typeof this.client !== 'undefined') {
        debug(`State is ${JSON.stringify(this.client)}`);
      }
      this.client = new net.Socket();

      // Attempt to connect
      debug('Connect', this.device.ip);
      this.client.connect(this.device.port, this.device.ip);

      // Default connect timeout is ~1 minute,
      // 10 seconds is a more reasonable default
      // since `retry` is used.
      this.client.setTimeout(this._connectTimeout * 1000, () => {
        /**
         * Emitted on socket error, usually a
         * result of a connection timeout.
         * Also emitted on parsing errors.
         * @event TuyaDevice#error
         * @property {Error} error error event
         */
        this.client.emit('error', new Error('connection timed out'));
        this.client.destroy();
      });

      // Send data when connected
      this.client.on('connect', () => {
        debug('Socket connected.');

        this._connected = true;

        // Remove connect timeout
        this.client.setTimeout(0);

        if (this.device.persistentConnection) {
          /**
           * Emitted when socket is connected
           * to device. This event may be emitted
           * multiple times within the same script,
           * so don't use this as a trigger for your
           * initialization code.
           * @event TuyaDevice#connected
           */
          this.emit('connected');

          if (this.pingpongTimeout) {
            clearTimeout(this.pingpongTimeout);
            this.pingpongTimeout = null;
          }

          this.pingpongTimeout = setTimeout(() => {
            this.__sendPing();
          }, this._pingPongPeriod * 1000);

          this.get({returnAsEvent: true});
        }
      });

      // Parse response data
      this.client.on('data', data => {
        debug('Received data back:', this.client.remoteAddress);
        debug(data.toString('hex'));

        clearTimeout(this._sendTimeout);

        if (this.pingpongTimeout) {
          clearTimeout(this.pingpongTimeout);
          this.pingpongTimeout = null;
        }

        this.pingpongTimeout = setTimeout(() => {
          this.__sendPing();
        }, this._pingPongPeriod * 1000);

        let dataRes;
        try {
          dataRes = Parser.parse(data);
        } catch (error) {
          debug(error);
          this.emit('error', error);
          return;
        }

        data = dataRes.data;

        if (typeof data === 'object') {
          debug('Data:', this.client.remoteAddress, data, dataRes.commandByte);
        } else if (typeof data === 'undefined') {
          if (dataRes.commandByte === 0x09) { // PONG received
            debug('PONG', this.device.ip, this.client ? this.client.destroyed : true);
            return;
          }

          debug('undefined', this.client.remoteAddress, data, dataRes.commandByte);
        } else { // Message is encrypted
          // eslint-disable-next-line max-len
          debug('decrypt', this.client.remoteAddress, this.device.cipher.decrypt(data), dataRes.commandByte);
          data = this.device.cipher.decrypt(data);
        }

        if (this.dataResolver) {
          if (this.dataResolver(data, dataRes.commandByte)) {
            this.dataResolver = null;
            this.dataRejector = null;
            return;
          }
        }

        if (this.device.persistentConnection && data) {
          /**
           * Emitted when data is returned from device.
           * @event TuyaDevice#data
           * @property {Object} data received data
           * @property {Number} commandByte
           * commandByte of result
           * (e.g. 7=requested response, 8=proactive update from device)
           */
          this.emit('data', data, dataRes.commandByte);
        } else {
          debug('Response undelivered.');
        }
      });

      // Handle errors
      this.client.on('error', err => {
        debug('Error event from socket.', this.device.ip, err);
        if (this.dataRejector) {
          this.dataRejector(err);
          this.dataRejector = null;
          this.dataResolver = null;
        } else if (this.device.persistentConnection) {
          this.emit('error', new Error('Error from socket'));
        }

        this.client.destroy();
      });

      // Handle errors
      this.client.on('close', () => {
        debug('Socket closed:', this.device.ip);
        
        this._connected = false;

        /**
         * Emitted when a socket is disconnected
         * from device. Not an exclusive event:
         * `error` and `disconnected` may be emitted
         * at the same time if, for example, the device
         * goes off the network.
         * @event TuyaDevice#disconnected
         */
        this.emit('disconnected');
        this.client.destroy();
        this.client = null;
        if (this.pingpongTimeout) {
          clearTimeout(this.pingpongTimeout);
          this.pingpongTimeout = null;
        }

        if (this.device.persistentConnection && !this._persistentConnectionStopped) {
          setTimeout(() => {
            this.connect();
          }, 1000);
        }
      });
    }

    return Promise.resolve(true);
  }

  /**
   * Disconnects from the device, use to
   * close the socket or exit gracefully
   * when using a persistent connection.
   * @returns {Promise<Boolean>}
   */
  disconnect(callback) {
    debug('Disconnect');
    
    this.client.on('close', () => {
      callback();
    });
    this._persistentConnectionStopped = true;
    this._connected = false;

    if (!this.client) {
      return;
    }

    this.client.destroy();
  }

  /**
   * Returns current connection status to device.
   * (`true` if connected, `false` otherwise.)
   * @returns {Boolean}
   */
  isConnected() {
    return this._connected;
  }
}

module.exports = TuyaDevice;
