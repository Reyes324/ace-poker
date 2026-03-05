'use strict';Object.defineProperty(exports, "__esModule", { value: true });var _classCallCheck2 = require('babel-runtime/helpers/classCallCheck');var _classCallCheck3 = _interopRequireDefault(_classCallCheck2);var _createClass2 = require('babel-runtime/helpers/createClass');var _createClass3 = _interopRequireDefault(_createClass2);var _ethereumjsUtil = require('ethereumjs-util');var _ethereumjsUtil2 = _interopRequireDefault(_ethereumjsUtil);function _interopRequireDefault(obj) {return obj && obj.__esModule ? obj : { default: obj };}var

Signer = function () {
  function Signer(values, payload, type) {(0, _classCallCheck3.default)(this, Signer);
    this.values = values;
    this.payload = payload;
    this.type = type;
  }(0, _createClass3.default)(Signer, [{ key: 'signToBuf', value: function signToBuf(

    privKey) {
      // build head
      var privBuf = new Buffer(privKey.replace('0x', ''), 'hex');
      var addr = _ethereumjsUtil2.default.privateToAddress(privBuf);
      var headBuf = Buffer.alloc(3);
      headBuf.writeInt8(this.type, 0);
      addr.copy(headBuf, 1, 18, 20);

      // sign and build tail
      var hash = _ethereumjsUtil2.default.sha3(Buffer.concat(this.payload));
      var sig = _ethereumjsUtil2.default.ecsign(hash, privBuf);
      this.payload[0].writeInt8(sig.v, 0);
      var bytes32 = [sig.r, sig.s, this.payload[0]];
      for (var i = 1; i < this.payload.length; i += 1) {
        bytes32.push(this.payload[i]);
      }
      return {
        head: headBuf,
        bytes32: bytes32 };

    } }, { key: 'sign', value: function sign(

    privKey) {
      var bufs = this.signToBuf(privKey);
      var rv = bufs.head.toString('base64');
      bufs.bytes32.forEach(function (buf) {
        rv += '.' + buf.toString('base64');
      });
      return rv;
    } }]);return Signer;}();exports.default = Signer;module.exports = exports['default'];