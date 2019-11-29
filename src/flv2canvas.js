/* eslint-disable no-case-declarations */

import Flv2canvasLoader from './flv2canvas.loader';
import YuvCanvas from './render/yuv-canvas';
class flv2canvas {
    constructor(options) {
        this.playWidth = 0;
        this.playHeight = 0;
        this.videoBuffer = [];
        this.videoDts = [];
        this.startPlay = false;
        this.hasFixPosition = false;
        this.options = options;
        this.canvasObj = {};

        this.loadCtl = new Flv2canvasLoader(options);

        this.loadCtl.saveDts = this._saveDts.bind(this);
        this.loader = this.loadCtl.createLoader();

        this.initRender();

        this.initWorker();


    }

    load() {

        this.loader.load();
    }

    play() {
        this.startPlay = true;
    }

    stop() {
        this.startPlay = false;
    }

    destory() {
        console.log('关闭播放器');
        let self = this;
        this.avc = null;
        this.videoDts = [];
        this.videoBuffer = [];
        this.loadCtl.destroy();
        if (this.worker) {
            this.worker.terminate();
        }

        window.cancelAnimationFrame(self.interval);
    }

    initWorker() {
        // this.worker = new Avc({
        //     rgb: false
        // });


        // this.worker.onPictureDecoded = this.onPictureDecoded.bind(this);
        console.log();
        this.worker = new Worker(this.options.workFile);
        this.loadCtl.worker = this.worker;
        // this.load();


        this.worker.postMessage({
            type: 'Broadway.js - Worker init', options: {
                rgb: false,
                memsize: '',
                reuseMemory: true
            }
        });

        let self = this;


        this.worker.addEventListener('error', function (event) {

        });
        this.worker.addEventListener('message', function (e) {

            let data = e.data;
            if (data.consoleLog) {
                console.log(data.consoleLog);

                self.load();
                return;
            }

            let typeArr2 = e.data.buf;
            let width = e.data.width;
            let height = e.data.height;

            self.onPictureDecoded(typeArr2, width, height, data.infos);

        }, false);

    }

    initRender() {
        let self = this;
        this.renderFrame = this.renderFrameWebGL;
        this.createCanvasObj = this.createCanvasWebGL;

        this.canvasObj = this.createCanvasObj();
        this.canvasObj.canvas = this.options.canvasDom;
        let last = Date.now();
        let diffTime = 0;
        let noData = 0;
        let fps = 20;
        let interval = 1000 / fps;
        let isLoading = false;

        doRender();
        function doRender() {

            self.interval = requestAnimationFrame(doRender);
            if (!self.startPlay) return;

            // if (self.videoBuffer.length > 30) {
            //     // self.audioDts = [];
            //     console.log('丢帧');

            //     var i = 0;
            //     while (i <= 10) {
            //         // 画面落后丢帧个数
            //         self.videoBuffer.shift();
            //         self.videoDts.shift();
            //         i++;
            //     }
            // }

            // if (self.videoDts.length === 0) {
            //     last = Date.now();
            //     return;
            // }

            // 判断加载中
            if (noData > 400) {
                console.log('重启');
                self.restart();
            }
            if (noData > 50 && !isLoading) {
                isLoading = true;
                self.showLoading(true);
            }

            if (self.videoBuffer.length === 0 && self.hasFixPosition) {
                console.log('没有数据noData', noData);

                noData++;
                return;
            }
            if (isLoading) {
                self.showLoading(false);
                isLoading = false;
            }

            noData = 0;

            let now = Date.now();
            diffTime = diffTime + (now - last);
            last = Date.now();


            // 减速
            if (self.videoBuffer.length < 15) {
                fps = 10;
                interval = 1000 / fps;
            }

            // 加速
            if (self.videoBuffer.length > 40) {
                fps = 25;
                interval = 1000 / fps;
            }

            if (self.videoBuffer.length > 25 && self.videoBuffer.length < 40) {
                fps = 20;
                interval = 1000 / fps;
            }

            // console.log('length', self.videoBuffer.length);

            // 满足帧数条件
            if (diffTime < interval) {
                return;
            }


            diffTime = diffTime % interval;
            if (self.videoBuffer[0]) {
                self.renderFrame({
                    canvasObj: self.canvasObj,
                    data: self.videoBuffer[0],
                    width: self.playWidth,
                    height: self.playHeight
                });
                self.videoBuffer.shift();

                if (!self.hasFixPosition) {
                    self.fixPosition();
                    self.showLoading(false);
                    console.log('Start to play,and fix position');
                    self.hasFixPosition = true;
                }
            } else {
                console.log('no data');
            }
        }
    }

    _saveDts(dts) {
        let videoDts = this.videoDts;
        if (videoDts.length === 0) {
            this.videoDts.push(dts);
        } else if (videoDts.length === 1) {
            if (dts > videoDts[0]) {
                this.videoDts.push(dts);
            } else {
                this.videoDts.unshift(dts);
            }
        }
        else {
            let isPush = false;
            for (let i = 0; i < this.videoDts.length; i++) {
                if (dts < this.videoDts[i] || dts === this.videoDts[i]) {

                    let arr1 = videoDts.slice(0, i);
                    let arr2 = videoDts.slice(i, videoDts.length);
                    arr1.push(dts);
                    this.videoDts = arr1.concat(arr2);

                    isPush = true;
                    break;
                }
            }

            if (!isPush) {
                this.videoDts.push(dts);
            }

        }


    }

    onPictureDecoded(buffer, width, height, infos) {

        window.decode2 = window.performance.now();
        // console.log(window.decode2 - window.decode1);
        if (document.hidden) return;
        this.playWidth = width;
        this.playHeight = height;
        this.videoBuffer.push(new Uint8Array(buffer));
        let self = this;
        if (this.videoBuffer.length > 50 && !this.startPlay) {
            console.log('clear', this.videoBuffer.length, this.videoDts.length);
            this.videoBuffer = [];
            self.videoDts = [];
            let i = 0;
            while (i < 50) {
                self.videoDts.shift();
                i++;
            }
        }
    }

    renderFrameWebGL(options) {
        let canvasObj = options.canvasObj;
        let width = options.width || canvasObj.canvas.width;
        let height = options.height || canvasObj.canvas.height;
        if (canvasObj.canvas.width !== width || canvasObj.canvas.height !== height || !canvasObj.webGLCanvas) {

            canvasObj.canvas.width = width;
            canvasObj.canvas.height = height;
            canvasObj.webGLCanvas = new YuvCanvas({
                canvas: canvasObj.canvas,
                contextOptions: canvasObj.contextOptions,
                width: width,
                height: height
            });
        }

        let ylen = width * height;
        let uvlen = (width / 2) * (height / 2);
        canvasObj.webGLCanvas.drawNextOutputPicture({
            yData: options.data.subarray(0, ylen),
            uData: options.data.subarray(ylen, ylen + uvlen),
            vData: options.data.subarray(ylen + uvlen, ylen + uvlen + uvlen)
        });

        let self = this;
        self.recycleMemory(options.data);
    }

    recycleMemory(parArray) {
        // this.worker.postMessage({ reuse: parArray.buffer }, [parArray.buffer]);
    }

    createCanvasWebGL(options) {
        let canvasObj = this._createBasicCanvasObj(options);
        // canvasObj.contextOptions = options.contextOptions;
        return canvasObj;
    }

    _createBasicCanvasObj(options) {
        options = options || {};

        let obj = {};

        obj.canvas = document.createElement('canvas');

        obj.canvas.style.backgroundColor = '#0D0E1B';


        return obj;
    }

    //调整画布位置 需要覆盖
    fixPosition() {

    }

    // loading效果
    showLoading() {

    }
}
export default flv2canvas;