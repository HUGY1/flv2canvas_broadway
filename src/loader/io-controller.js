
import FetchStreamLoader from './fetch-stream-loader.js';

import EventEmitter from 'events';
import FLVDemuxer from '../demux/flv-demuxer.js';
import SpeedSampler from './speed-sampler.js';


class IOController {
    constructor(config) {
        this._config = config;
        this._loader = null;
        this._loaderClass = null;
        this._seekHandler = null;


        this._emitter = new EventEmitter();

        this._stashUsed = 0;
        this._stashSize = this._stashInitialSize;
        this._bufferSize = 1024 * 1024 * 3;  // initial size: 3MB
        this._stashBuffer = new ArrayBuffer(this._bufferSize);
        this._stashByteStart = 0;
        this._enableStash = true;
        if (config.enableStashBuffer === false) {
            this._enableStash = false;
        }



        this._totalLength = this._refTotalLength;
        this._fullRequestFlag = false;
        this._currentRange = null;
        this._redirectedURL = null;
        this._speedNormalized = 0;
        this._speedSampler = new SpeedSampler();
        this._speedNormalizeList = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

        this._selectLoader();
        this._createLoader();
    }

    _selectLoader() {
        if (FetchStreamLoader.isSupported()) {
            this._loaderClass = FetchStreamLoader;
        }
    }

    _createLoader() {
        this._loader = new this._loaderClass(this._config);
        if (this._loader.needStashBuffer === false) {
            this._enableStash = false;
        }
        // this._loader.onContentLengthKnown = this._onContentLengthKnown.bind(this);
        // this._loader.onURLRedirect = this._onURLRedirect.bind(this);
        // this._loader.onDataArrival = this._onLoaderChunkArrival.bind(this);
        // this._loader.onComplete = this._onLoaderComplete.bind(this);
        // this._loader.onError = this._onLoaderError.bind(this);
    }

    load() {
        this._loader.onDataArrival = this._onLoaderChunkArrival.bind(this);
        this._loader.open();
    }

    _onInitChunkArrival(data, byteStart) {

        let probeData = null;
        let consumed = 0;
        if (byteStart > 0) {
            // IOController seeked immediately after opened, byteStart > 0 callback may received
            this._demuxer.bindDataSource(this._loader);

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else if ((probeData = FLVDemuxer.probe(data)).match) {
            // Always create new FLVDemuxer
            this._demuxer = new FLVDemuxer(probeData, this._config);
            this._demuxer.onVideoParseDone = this._onVideoParseDone.bind(this);
            this._demuxer.onAudioParseDone = this._onAudioParseDone.bind(this);
            this._demuxer.saveDts = this._saveDts.bind(this);

            // if (!this._remuxer) {
            //     this._remuxer = new MP4Remuxer(this._config);
            // }

            // let mds = this._mediaDataSource;
            // if (mds.duration != undefined && !isNaN(mds.duration)) {
            //     this._demuxer.overridedDuration = mds.duration;
            // }
            // if (typeof mds.hasAudio === 'boolean') {
            //     this._demuxer.overridedHasAudio = mds.hasAudio;
            // }
            // if (typeof mds.hasVideo === 'boolean') {
            //     this._demuxer.overridedHasVideo = mds.hasVideo;
            // }

            // this._demuxer.timestampBase = mds.segments[this._currentSegmentIndex].timestampBase;

            // this._demuxer.onError = this._onDemuxException.bind(this);
            // this._demuxer.onMediaInfo = this._onMediaInfo.bind(this);
            // this._demuxer.onMetaDataArrived = this._onMetaDataArrived.bind(this);
            this._demuxer.onScriptDataArrived = this._onScriptDataArrived.bind(this);

            // this._remuxer.bindDataSource(this._demuxer
            //              .bindDataSource(this._ioctl
            // ));

            // this._remuxer.onInitSegment = this._onRemuxerInitSegmentArrival.bind(this);
            // this._remuxer.onMediaSegment = this._onRemuxerMediaSegmentArrival.bind(this);

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else {
            probeData = null;
            // Log.e(this.TAG, 'Non-FLV, Unsupported media type!');

        }

        return consumed;
    }

    _normalizeSpeed(input) {
        let list = this._speedNormalizeList;
        let last = list.length - 1;
        let mid = 0;
        let lbound = 0;
        let ubound = last;

        if (input < list[0]) {
            return list[0];
        }

        // binary search
        while (lbound <= ubound) {
            mid = lbound + Math.floor((ubound - lbound) / 2);
            if (mid === last || (input >= list[mid] && input < list[mid + 1])) {
                return list[mid];
            } else if (list[mid] < input) {
                lbound = mid + 1;
            } else {
                ubound = mid - 1;
            }
        }
    }

    _onLoaderChunkArrival(chunk, byteStart, receivedLength) {
       
        if (!this._onDataArrival) {
                // throw new IllegalStateException('IOController: No existing consumer (onDataArrival) callback!');
        }
        if (this._paused) {
            return;
        }
        if (this._isEarlyEofReconnecting) {
                // Auto-reconnect for EarlyEof succeed, notify to upper-layer by callback
            this._isEarlyEofReconnecting = false;
            if (this._onRecoveredEarlyEof) {
                this._onRecoveredEarlyEof();
            }
        }

        this._speedSampler.addBytes(chunk.byteLength);

            // adjust stash buffer size according to network speed dynamically
        let KBps = this._speedSampler.lastSecondKBps;
        if (KBps !== 0) {
            let normalized = this._normalizeSpeed(KBps);
            if (this._speedNormalized !== normalized) {
                this._speedNormalized = normalized;
                this._adjustStashSize(normalized);
            }
        }

        if (!this._enableStash) {  // disable stash
            if (this._stashUsed === 0) {
                    // dispatch chunk directly to consumer;
                    // check ret value (consumed bytes) and stash unconsumed to stashBuffer
                let consumed = this._dispatchChunks(chunk, byteStart);
                if (consumed < chunk.byteLength) {  // unconsumed data remain.
                    let remain = chunk.byteLength - consumed;
                    if (remain > this._bufferSize) {
                        this._expandBuffer(remain);
                    }
                    let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                    stashArray.set(new Uint8Array(chunk, consumed), 0);
                    this._stashUsed += remain;
                    this._stashByteStart = byteStart + consumed;
                }
            } else {
                    // else: Merge chunk into stashBuffer, and dispatch stashBuffer to consumer.
                if (this._stashUsed + chunk.byteLength > this._bufferSize) {
                    this._expandBuffer(this._stashUsed + chunk.byteLength);
                }
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                stashArray.set(new Uint8Array(chunk), this._stashUsed);
                this._stashUsed += chunk.byteLength;
                let consumed = this._dispatchChunks(this._stashBuffer.slice(0, this._stashUsed), this._stashByteStart);
                if (consumed < this._stashUsed && consumed > 0) {  // unconsumed data remain
                    let remainArray = new Uint8Array(this._stashBuffer, consumed);
                    stashArray.set(remainArray, 0);
                }
                this._stashUsed -= consumed;
                this._stashByteStart += consumed;
            }
        } else {  // enable stash
            if (this._stashUsed === 0 && this._stashByteStart === 0) {  // seeked? or init chunk?
                    // This is the first chunk after seek action
                this._stashByteStart = byteStart;
            }
            if (this._stashUsed + chunk.byteLength <= this._stashSize) {
                    // just stash
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._stashSize);
                stashArray.set(new Uint8Array(chunk), this._stashUsed);
                this._stashUsed += chunk.byteLength;
            } else {  // stashUsed + chunkSize > stashSize, size limit exceeded
                let stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                if (this._stashUsed > 0) {  // There're stash datas in buffer
                        // dispatch the whole stashBuffer, and stash remain data
                        // then append chunk to stashBuffer (stash)
                    let buffer = this._stashBuffer.slice(0, this._stashUsed);
                    let consumed = this._dispatchChunks(buffer, this._stashByteStart);
                    if (consumed < buffer.byteLength) {
                        if (consumed > 0) {
                            let remainArray = new Uint8Array(buffer, consumed);
                            stashArray.set(remainArray, 0);
                            this._stashUsed = remainArray.byteLength;
                            this._stashByteStart += consumed;
                        }
                    } else {
                        this._stashUsed = 0;
                        this._stashByteStart += consumed;
                    }
                    if (this._stashUsed + chunk.byteLength > this._bufferSize) {
                        this._expandBuffer(this._stashUsed + chunk.byteLength);
                        stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                    }
                    stashArray.set(new Uint8Array(chunk), this._stashUsed);
                    this._stashUsed += chunk.byteLength;
                } else {  // stash buffer empty, but chunkSize > stashSize (oh, holy shit)
                        // dispatch chunk directly and stash remain data
                    let consumed = this._dispatchChunks(chunk, byteStart);
                    if (consumed < chunk.byteLength) {
                        let remain = chunk.byteLength - consumed;
                        if (remain > this._bufferSize) {
                            this._expandBuffer(remain);
                            stashArray = new Uint8Array(this._stashBuffer, 0, this._bufferSize);
                        }
                        stashArray.set(new Uint8Array(chunk, consumed), 0);
                        this._stashUsed += remain;
                        this._stashByteStart = byteStart + consumed;
                    }
                }
            }
        }
  



    }

    _adjustStashSize(normalized) {
        let stashSizeKB = 0;

        if (this._config.isLive) {
            // live stream: always use single normalized speed for size of stashSizeKB
            stashSizeKB = normalized;
        } else {
            if (normalized < 512) {
                stashSizeKB = normalized;
            } else if (normalized >= 512 && normalized <= 1024) {
                stashSizeKB = Math.floor(normalized * 1.5);
            } else {
                stashSizeKB = normalized * 2;
            }
        }

        if (stashSizeKB > 8192) {
            stashSizeKB = 8192;
        }

        let bufferSize = stashSizeKB * 1024 + 1024 * 1024 * 1;  // stashSize + 1MB
        if (this._bufferSize < bufferSize) {
            this._expandBuffer(bufferSize);
        }
        this._stashSize = stashSizeKB * 1024;
    }

    _expandBuffer(expectedBytes) {
        let bufferNewSize = this._stashSize;
        while (bufferNewSize + 1024 * 1024 * 1 < expectedBytes) {
            bufferNewSize *= 2;
        }

        bufferNewSize += 1024 * 1024 * 1;  // bufferSize = stashSize + 1MB
        if (bufferNewSize === this._bufferSize) {
            return;
        }

        let newBuffer = new ArrayBuffer(bufferNewSize);

        if (this._stashUsed > 0) {  // copy existing data into new buffer
            let stashOldArray = new Uint8Array(this._stashBuffer, 0, this._stashUsed);
            let stashNewArray = new Uint8Array(newBuffer, 0, bufferNewSize);
            stashNewArray.set(stashOldArray, 0);
        }

        this._stashBuffer = newBuffer;
        this._bufferSize = bufferNewSize;
    }

    _dispatchChunks(chunks, byteStart) {
        // this._currentRange.to = byteStart + chunks.byteLength - 1;
        return this._onInitChunkArrival(chunks, byteStart);
    }

    _onScriptDataArrived(data) {
        // this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data);
    }

    _onVideoParseDone(data) {
        this.onVideoParseDone(data);
    }

    _onAudioParseDone(data) {
        this.onAudioParseDone(data);
    }

    _saveDts(data) {

        this.saveDts(data);
    }

    destroy() {
        console.log('销毁');
        this._loader.destroy();
    }

    onVideoParseDone() { }

    onAudioParseDone() { }
}

export default IOController;