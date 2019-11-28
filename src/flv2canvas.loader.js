import Polyfill from './utils/polyfill.js';
import IOController from './loader/io-controller';
// install polyfills
Polyfill.install();


// feature detection
function isSupported() {
    return true;
}


// flv2canvasLoader.getFeatureList = getFeatureList;

// flv2canvasLoader.BaseLoader = BaseLoader;
// flv2canvasLoader.LoaderStatus = LoaderStatus;
// flv2canvasLoader.LoaderErrors = LoaderErrors;

// flv2canvasLoader.Events = PlayerEvents;
// flv2canvasLoader.ErrorTypes = ErrorTypes;
// flv2canvasLoader.ErrorDetails = ErrorDetails;

// flv2canvasLoader.FlvPlayer = FlvPlayer;
// flv2canvasLoader.LoggingControl = LoggingControl;

class Flv2CanvasLoader {
    constructor(optionalConfig) {
        this._config = optionalConfig;
    }

    createLoader() {
        this.ioctl = new IOController(this._config);
        this.ioctl.onVideoParseDone = this._onVideoParseDone.bind(this);
        this.ioctl.onAudioParseDone = this._onAudioParseDone.bind(this);
        this.ioctl.saveDts = this._saveDts.bind(this);
        return this.ioctl;
    }

    _onVideoParseDone(data) {
        // post video h264 to woker
        let copyU8 = new Uint8Array(data.length);
        copyU8.set(data, 0, data.length);


        window.demuxer2 = window.performance.now();
        window.decode1 = window.performance.now();
        this.worker.postMessage({
            // type: 'sendArrayVideo',
            buffer: copyU8,
            offset: 0, 
            length: data.length
        }, [copyU8.buffer]);
        // this.worker.decode(copyU8);
    }

    _saveDts(data) {
        this.saveDts(data);

    }
    _onAudioParseDone(data) {
        // post audio to woker
    }

    destroy() {
        this.ioctl.destroy();
    }
}


export default Flv2CanvasLoader;