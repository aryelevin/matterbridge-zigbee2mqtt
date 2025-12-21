import * as fs from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';
import * as url from 'node:url';
import * as qs from 'node:querystring';
import * as path from 'node:path';
import { ClientRequest, IncomingMessage } from 'node:http';
// import { er } from 'node-ansi-logger';

const pUrl = 'https://api.pushover.net/1/messages.json';

/**
 * @description Set default values for Pushover parameters.
 * @param {object} o - The parameters object.
 * @returns {object} The parameters object with default values set.
 */
function setDefaults(o: { [key: string]: string | number | boolean }) {
  const def = ['device', 'title', 'url', 'url_title', 'priority', 'timestamp', 'sound'];

  let i = 0;
  const l = def.length;
  for (; i < l; i++) {
    if (!o[def[i]]) {
      o[def[i]] = '';
    }
  }

  return o;
}

/**
 * @description Load an image from the filesystem.
 * @param {string} imgPath - The path to the image file.
 * @returns {object} An object containing the name and data of the image.
 */
function loadImage(imgPath: string): { name: string; data: Buffer } {
  const o = { name: '', data: Buffer.alloc(0) };
  o.name = path.basename(imgPath);
  o.data = fs.readFileSync(imgPath);
  return o;
}

/**
 * @description Convert request string to multipart/form-data format.
 * @param {string} rs - The request string.
 * @param {string} b - The boundary string.
 * @param {object} [imgObj] - An optional image object.
 * @returns {Buffer} The multipart/form-data payload.
 */
function reqString2MP(rs: string, b: string, imgObj?: { [key: string]: string | Buffer }): Buffer<ArrayBuffer> {
  const a = [];
  // const parts = [];
  const o = qs.parse(rs);

  a.push(b);

  for (const p in o) {
    if (o[p] !== '') {
      a.push('Content-Disposition: form-data; name="' + p + '"');
      a.push('');
      a.push(o[p]);
      a.push(b);
    }
  }

  if (imgObj) {
    a.push('Content-Disposition: form-data; name="attachment"; filename="' + imgObj.name + '"');
    if (Object.prototype.hasOwnProperty.call(imgObj, 'type')) {
      a.push('Content-Type: ' + imgObj.type);
    } else {
      a.push('Content-Type: application/octet-stream');
    }
    a.push('');
    a.push('');
  } else {
    a.splice(-1, 1);
  }

  let payload;
  if (imgObj) {
    payload = Buffer.concat([Buffer.from(a.join('\r\n'), 'utf8'), Buffer.from(imgObj.data as string, 'binary'), Buffer.from('\r\n' + b + '--\r\n', 'utf8')]);
  } else {
    payload = Buffer.concat([Buffer.from(a.join('\r\n'), 'utf8'), Buffer.from(b + '--\r\n', 'utf8')]);
  }
  return payload;
}

export class Pushover {
  boundary: string;
  token: string;
  user: string;
  httpOptions?: { [key: string]: string } | undefined;
  sounds: Record<string, string>;
  debug: boolean = false;
  onerror: ((error: string, res?: IncomingMessage) => void) | null = null;
  constructor(opts: {
    token: string;
    user: string;
    httpOptions?: { [key: string]: string };
    debug?: boolean;
    onerror?: (error: string, res?: IncomingMessage) => void;
    update_sounds?: boolean;
  }) {
    this.boundary = '--' + Math.random().toString(36).substring(2);
    this.token = opts.token;
    this.user = opts.user;
    this.httpOptions = opts.httpOptions;
    this.sounds = {
      pushover: 'Pushover (default)',
      bike: 'Bike',
      bugle: 'Bugle',
      cashregister: 'Cash Register',
      classical: 'Classical',
      cosmic: 'Cosmic',
      falling: 'Falling',
      gamelan: 'Gamelan',
      incoming: 'Incoming',
      intermission: 'Intermission',
      magic: 'Magic',
      mechanical: 'Mechanical',
      pianobar: 'Piano Bar',
      siren: 'Siren',
      spacealarm: 'Space Alarm',
      tugboat: 'Tug Boat',
      alien: 'Alien Alarm (long)',
      climb: 'Climb (long)',
      persistent: 'Persistent (long)',
      echo: 'Pushover Echo (long)',
      updown: 'Up Down (long)',
      none: 'None (silent)',
    };

    if (opts.debug) {
      this.debug = opts.debug;
    }

    if (opts.onerror) {
      this.onerror = opts.onerror;
    }

    if (opts.update_sounds) {
      this.updateSounds();
      setInterval(() => {
        this.updateSounds();
      }, 86400000);
    }
  }

  errors(d: string | AggregateError, res?: IncomingMessage) {
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch (error) {
        let errMsg = String(error);
        if (error instanceof Error) {
          console.error('Error message:', error.message);
          console.error('Error stack:', error.stack);
          errMsg = error.message;
        } else {
          console.error('An unknown error occurred:', error);
        }
        this.onerror?.(errMsg, res);
      }
    } else if (d.errors) {
      if (this.onerror) {
        this.onerror(d.errors[0], res);
      } else {
        // If no onerror was provided throw our error
        throw new Error(d.errors[0]);
      }
    }
  }

  updateSounds() {
    let data = '';
    const surl = 'https://api.pushover.net/1/sounds.json?token=' + this.token;
    const req = https.request(new url.URL(surl), (res: IncomingMessage) => {
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          this.errors(data, res);
          this.sounds = j.sounds;
        } catch (error) {
          console.log(error);
          this.errors('Pushover: parsing sound data failed', res);
        }
      });

      res.on('data', (chunk) => {
        data += chunk;
      });
    });

    req.on('error', (e) => {
      this.errors(e.message);
    });

    req.write('');
    req.end();
  }

  send(obj: { [key: string]: string | number | boolean }, callback?: ((err?: Error, result?: string, res?: http.IncomingMessage) => void) | null, casigningcert?: Buffer | null) {
    const urlObject = new url.URL(pUrl);
    const o: { [key: string]: string | number | boolean | object } = {
      host: urlObject.hostname,
      port: urlObject.port,
      path: urlObject.pathname,
      method: 'POST',
    };
    let proxy;

    obj = setDefaults(obj);

    const reqString: { [key: string]: string | number | boolean } = {
      token: this.token || obj.token,
      user: this.user || obj.user,
    };

    let p;
    for (p in obj) {
      if (obj[p] !== '') {
        if (p !== 'file') {
          reqString[p] = obj[p];
        }
      }
    }

    const qsString = qs.stringify(reqString);

    let mp = Buffer.alloc(0);
    if (obj.file) {
      if (typeof obj.file === 'string') {
        mp = reqString2MP(qsString, this.boundary, loadImage(obj.file));
      }
      if (typeof obj.file === 'object') {
        mp = reqString2MP(qsString, this.boundary, obj.file);
      }
    } else {
      mp = reqString2MP(qsString, this.boundary);
    }

    const headersObj: { [key: string]: string | number | boolean | object } = {
      'Content-Type': 'multipart/form-data; boundary=' + this.boundary.substring(2),
      'Content-Length': mp.length,
    };
    const httpOpts = this.httpOptions;
    if (httpOpts) {
      Object.keys(httpOpts).forEach(function (key) {
        if (key !== 'proxy') {
          o[key] = httpOpts[key];
        }
      });
    }

    if (Object.prototype.hasOwnProperty.call(httpOpts, 'proxy') && httpOpts?.proxy && httpOpts.proxy !== '') {
      proxy = new url.URL(httpOpts.proxy);
      headersObj.Host = o.host;
      o.host = proxy.hostname;
      o.protocol = proxy.protocol;
    }

    o.headers = headersObj;

    let request: (options: string | url.URL | https.RequestOptions, callback?: (res: IncomingMessage) => void) => ClientRequest;
    if ((httpOpts?.proxy && httpOpts.proxy !== '') || pUrl.match(/http:/)) {
      request = http.request;
    } else {
      request = https.request;
    }

    if (casigningcert) {
      o.ca = casigningcert;
    }

    const req = request(o, (res: IncomingMessage) => {
      if (this.debug) {
        console.log(res.statusCode);
      }
      let err;
      let data = '';
      res.on('end', () => {
        this.errors(data, res);
        if (callback) {
          callback(err, data, res);
        }
      });

      res.on('data', (chunk: string) => {
        data += chunk;
      });
    });

    req.on('error', (err) => {
      if (callback) {
        callback(err);
      }
      // In the tests the "end" event did not get emitted if  "error" was emitted,
      // but to be sure that the callback is not get called twice, null the callback function
      callback = null;
    });

    if (this.debug) {
      console.log(qsString.replace(this.token, 'XXXXX').replace(this.user, 'XXXXX'));
    }

    req.write(mp);
    req.end();
  }
}

Pushover.prototype.send = function (obj, fn) {
  this.send(obj, fn, null);
};
