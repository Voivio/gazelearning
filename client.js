// import { ZoomMtg } from '@zoomus/websdk';

// var ZoomMtg = require('@zoomus/websdk');
var calibrated = false;
var wg_started = false;
var gc_started = false;
var heatmapInstance = null;
var hm_left = 0;
var hm_top = 0;
var hm_created = false;

window.onload = async function () {

    //////set callbacks for GazeCloudAPI/////////
    GazeCloudAPI.OnCalibrationComplete = function () {
        console.log('gaze Calibration Complete');
        calibrated = true;
        var pos = findAbsolutePosition(document.getElementById('container'));
        hm_left = pos.left;
        hm_top = pos.top;
    }
    GazeCloudAPI.OnCamDenied = function () { console.log('camera  access denied') }
    GazeCloudAPI.OnError = function (msg) { console.log('err: ' + msg) }
    GazeCloudAPI.UseClickRecalibration = true;
    GazeCloudAPI.OnResult = PlotGaze;

    // WebGazer
    webgazer.params.showVideoPreview = true;
    //start the webgazer tracker
    await webgazer.setRegression('ridge') /* currently must set regression and tracker */
        //.setTracker('clmtrackr')
        .setGazeListener(function (data, clock) {
            //   console.log(data); /* data is an object containing an x and y key which are the x and y prediction coordinates (no bounds limiting) */
            //   console.log(clock); /* elapsed time in milliseconds since webgazer.begin() was called */
            if (data == null) {
                return;
            }
            var xprediction = data.x; //these x coordinates are relative to the viewport
            var yprediction = data.y; //these y coordinates are relative to the viewport
            var dataPoint = {
                x: xprediction - hm_left, // x coordinate of the datapoint, a number
                y: yprediction - hm_top, // y coordinate of the datapoint, a number
                value: 10 // the value at datapoint(x, y)
            };

            var gaze = document.getElementById("gaze");
            xprediction -= gaze.clientWidth / 2;
            yprediction -= gaze.clientHeight / 2;

            gaze.style.left = xprediction + "px";
            gaze.style.top = yprediction + "px";

            try {
                if (hm_created)
                    heatmapInstance.addData(dataPoint);
            } catch (err) {
                console.log('Error caught!', err);
            }

            // console.log(xprediction, yprediction);
            // console.log(elapsedTime);
        });
    // webgazer.showPredictionPoints(true); /* shows a square every 100 milliseconds where current prediction is */
    function hideVideoElements() {
        webgazer.showPredictionPoints(false);
        webgazer.showVideo(false);
        webgazer.showFaceOverlay(false);
        webgazer.showFaceFeedbackBox(false);
        //webgazer.showGazeDot(false);
    };
    hideVideoElements();

    const domain = 'meet.jit.si';
    const options = {
        roomName: 'gazelearningtesting',
        width: '100%',
        height: screen.height * 0.8 + 'px',
        parentNode: document.querySelector('#container')
    };
    const api = new JitsiMeetExternalAPI(domain, options);

    // create heatmap with configuration
    // create configuration object
    // toggleHeatmap();

    // ZoomMtg.setZoomJSLib('node_modules/@zoomus/websdk/dist/lib', '/av');
    // ZoomMtg.preLoadWasm();
    // ZoomMtg.prepareJssdk();

    // const zoomMeeting = document.getElementById("zmmtg-root");

}

async function toggleHeatmap() {
    if (hm_created) {
        document.getElementsByClassName('heatmap-canvas')[0].remove();
        hm_created = false;
    } else {
        var config = {
            container: document.getElementById('container'),
            radius: 50,
            maxOpacity: .5,
            minOpacity: 0,
            blur: .75
        };
        heatmapInstance = h337.create(config);
        heatmapInstance.setDataMax(200);
        hm_created = true;
    }
}

async function changeGC() {
    // change to enabled
    if (document.getElementById("et2").checked) {
        document.getElementById("et1").checked = false;
        document.getElementById("webgazeropts").style.display = 'none';
        if (wg_started) {
            await webgazer.end();
            // closeWebGazer();
            wg_started = false;
        }
        document.getElementById("gazecloudopts").style.display = 'initial';
        gc_started = true;
        if (calibrated)
            document.getElementById("gaze").style.display = 'block';

    } else {
        document.getElementById("gazecloudopts").style.display = 'none';
        GazeCloudAPI.StopEyeTracking();
        gc_started = false;
        document.getElementById("gaze").style.display = 'none';
    }
}
// document.getElementById('et2').onchange = function () { changeWG() };
async function changeWG() {
    if (document.getElementById("et1").checked) {
        document.getElementById("et2").checked = false;
        document.getElementById("gazecloudopts").style.display = 'none';
        document.getElementById("gaze").style.display = 'none';
        GazeCloudAPI.StopEyeTracking();
        gc_started = false;
        document.getElementById("webgazeropts").style.display = 'initial';
    } else {
        document.getElementById("webgazeropts").style.display = 'none';
        if (wg_started) {
            await webgazer.end();
            // closeWebGazer();
            wg_started = false;
        }
        document.getElementById("gaze").style.display = 'none';
    }
}

function closeWebGazer() {
    var webgazer_elems = ['webgazerFaceOverlay',
        'webgazerFaceFeedbackBox',
        'webgazerGazeDot',
        'webgazerFaceOverlay',
        'webgazerVideoCanvas'];
    for (var i = 0; i < 5; ++i) {
        try {
            document.getElementById(webgazer_elems[i]).remove();
        } catch (err) {
            console.log('Error caught!', err);
        }
    }
    // webgazer_elems.forEach(elem => document.getElementById(elem).remove());
}


async function beginWG() {
    if (!wg_started) {
        await webgazer.begin();
        wg_started = true;
        document.getElementById("gaze").style.display = 'block';
    }
}

async function endWG() {
    if (wg_started) {
        await webgazer.end();
        // closeWebGazer();
        wg_started = false;
        document.getElementById("gaze").style.display = 'none';
    }
}

function findAbsolutePosition(htmlElement) {
    var x = htmlElement.offsetLeft;
    var y = htmlElement.offsetTop;
    for (var x = 0, y = 0, el = htmlElement;
        el != null;
        el = el.offsetParent) {
        x += el.offsetLeft;
        y += el.offsetTop;
    }
    return {
        "left": x,
        "top": y
    };
}

function PlotGaze(GazeData) {
    /*
        GazeData.state // 0: valid gaze data; -1 : face tracking lost, 1 : gaze uncalibrated
        GazeData.docX // gaze x in document coordinates
        GazeData.docY // gaze y in document cordinates
        GazeData.time // timestamp
    */

    var docx = GazeData.docX;
    var docy = GazeData.docY;

    if (calibrated) {
        var dataPoint = {
            x: docx - hm_left, // x coordinate of the datapoint, a number
            y: docy - hm_top, // y coordinate of the datapoint, a number
            value: 10 // the value at datapoint(x, y)
        };
        if (hm_created)
            heatmapInstance.addData(dataPoint);
    }

    var gaze = document.getElementById("gaze");
    docx -= gaze.clientWidth / 2;
    docy -= gaze.clientHeight / 2;

    gaze.style.left = docx + "px";
    gaze.style.top = docy + "px";


    if (GazeData.state != 0) {
        if (gaze.style.display == 'block')
            gaze.style.display = 'none';
    }
    else {
        if (gaze.style.display == 'none')
            gaze.style.display = 'block';
    }
}
window.onbeforeunload = function () {
    webgazer.end();
    // closeWebGazer();
}

// Kalman Filter defaults to on. Can be toggled by user.
window.applyKalmanFilter = true;

// Set to true if you want to save the data even if you reload the page.
window.saveDataAcrossSessions = true;

// @string.Format("https://zoom.us/wc/{0}/join?prefer=0&un={1}", ViewBag.Id, System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("Name Test")))