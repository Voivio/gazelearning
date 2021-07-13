// import { ZoomMtg } from '@zoomus/websdk';
// var ZoomMtg = require('@zoomus/websdk');
// ==============================================================
document.addEventListener("DOMContentLoaded", () => openModal("before-lecture-modal"));
document.addEventListener('visibilitychange', reportInattention)

window.onload = async function () {
    // Fetch experiment setting
    console.log('========== Preparing ==========');
    try {
        await fetchSetting();
    } catch (e) {
        gazeInfo = true;
        cogInfo = true;
        console.error('Failed to fetch experiment setting.');
        console.warn('Will use default setting.');
    }

    //////set callbacks for GazeCloudAPI/////////
    GazeCloudAPI.APIKey= "ucsd_NonCommercialUse";
    GazeCloudAPI.OnCalibrationComplete = function () {
        console.log('gaze Calibration Complete');
        calibrated = true;
        var pos = findAbsolutePosition(document.getElementById('container'));
        hm_left = pos.left;
        hm_top = pos.top;
        // [Adaptive] Follow openModal function to see how to adapt to different experiment settings
        // coginfo in need and not collected
        if (cogInfo && totalConfused > 0) openModal('initModal');
    }
    GazeCloudAPI.OnCamDenied = function () { console.log('camera access denied') }
    GazeCloudAPI.OnError = function (msg) { console.log('err: ' + msg) }
    GazeCloudAPI.UseClickRecalibration = true;
    GazeCloudAPI.OnResult = PlotGaze;

    // 2021.1.4 instead of canvas, the visualization is moved to SVG.
    // let svgNode = document.createElement("svg");
    // svgNode.id = 'plotting_svg';
    // document.getElementById('container').appendChild(svgNode);

    // let containerRect = document.getElementById("container").getBoundingClientRect();
    // maxH = containerRect.height;
    // maxW = containerRect.width;
    // let svg = d3.select("#plotting_svg")
    //     .attr("width", maxW)
    //     .attr("height", maxH);

    let svg = d3.select("#plotting_svg");
    svg.on('click', (e)=>report(e))
        .style("left", 0)
        .style("top", 0)
        .style("width", 0)
        .style("height", 0);

    // ZoomMtg.setZoomJSLib('node_modules/@zoomus/websdk/dist/lib', '/av');
    // ZoomMtg.preLoadWasm();
    // ZoomMtg.prepareJssdk();

    // const zoomMeeting = document.getElementById("zmmtg-root");

    // ==============================================================
    // confusion detection initializations
    videoElement = document.getElementById('input_video');
    canvasElement = document.getElementById('output_canvas');
    canvasCtx = canvasElement.getContext('2d');
    collectElement = document.getElementById('collect_canvas');
    collectCtx = collectElement.getContext('2d');
    // ==============================================================

    selectCamera();

    if (SOCKET) {
        socket.emit("ready");
    } else {
        blockStart();
    }
}

// @string.Format("https://zoom.us/wc/{0}/join?prefer=0&un={1}", ViewBag.Id, System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("Name Test")))

// Sync Gaze Information
function collectionStart(fastMode) {
    if (fastMode) {
        console.log('Fast mode is on. No data collection process.')
        totalConfused = 0;
        totalNeutral = 0;
        syncCountdown();
    } else {
        collecting = CONFUSED; // start with collecting confused expressions
    }
    // var last_infer_ts = Date.now();
    if (navigator.mediaDevices.enumerateDevices) {
        const camera = new Camera(videoElement, {
            onFrame: async () => {
                if (collecting !== NOTCOLLECTING) {
                    // make sure data collection starts first
                    await dataCollecting();
                } else if (totalConfused === 0 && totalNeutral === 0) {
                    // Collection is done. Do nothing.
                    // if (Date.now() - last_infer_ts >= 2500) {
                    //     stateInference();
                    //     last_infer_ts = Date.now()
                    // }

                }
            },
            width: 320,
            height: 180,
            deviceId: cameraId,
        });
        camera.start();
    }
}

// [Entry 2] Lecture
if (SOCKET) socket.on("student start", syncStart);

async function sync(){
    console.log('========== Synchronizing ==========');
    let infer = setInterval(() => {
        updateGazePoints()
            .catch(err => {
                clearInterval(infer);
                console.error(err)
            });
    }, inferInterval);
}

async function updateGazePoints() {
    // Facial expression collection is not finished yet
    if (totalConfused !== 0 || totalNeutral !== 0) return;

    stateInference().then(()=>{
        if (secondCounter % updateInterval === 0) {
            console.log(`[#${secondCounter/updateInterval+1} update - ${Math.floor(secondCounter/60)} min ${secondCounter%60} sec]`)
            update();
        }
    });
    // error will be handled by parent function, because its async, error are returned in Promise
}

async function update() {
    // decide what to post, then post using function signaling()
    let identity = userInfo['identity']; //teacher(2) or student(1)
    let studentNumber = userInfo['number'];

    let samples;
    if (RANDOM) {
        // ==============================================================
        // Random test part
        // Math.random() returns a random number inclusive of 0, but not 1
        // only choose last two built-in gaze traces since they have timestamp information
        // ==============================================================
        let randomGazeIndex = Math.floor(Math.random() * (GazeX.length - 2)) + 2;
        let beginTimestamp = Math.floor(Math.random() * timestamp[randomGazeIndex].length * 0.75);
        let endTimestamp = beginTimestamp;
        while (timestamp[randomGazeIndex][endTimestamp] - timestamp[randomGazeIndex][beginTimestamp] < updateInterval * 1000) {
            endTimestamp++;
        }
        timestamp_win = timestamp[randomGazeIndex].slice(beginTimestamp, endTimestamp);

        for (let i = 0; i < updateInterval; i++) {
            confusion_win[i] = 'N/A';
        }
        if (Math.random() > 0.3) {
            for (let i = 0; i < updateInterval; i++) {
                confusion_win[i] = Math.random() > 0.5 ? "Confused" : "Neutral";
            }
        }

        inattention_counter = Math.random() > 0.5 ? 1 : 0;

        samples = {
            x: GazeX[randomGazeIndex].slice(beginTimestamp, endTimestamp),
            y: GazeY[randomGazeIndex].slice(beginTimestamp, endTimestamp),
            t: timestamp[randomGazeIndex].slice(beginTimestamp, endTimestamp),
        };
    } else {
        samples = {
            x: gazeX_win,
            y: gazeY_win,
            t: timestamp_win,
        };

        // For persistent notification on instructor's side
        if (document.visibilityState === 'hidden') ++inattention_counter;
    }

    let fixations = [],
        saccades = [];
    // [Adaptive] Binding confusion with fixations
    if (gazeInfo) [fixations, saccades] = fixationConfusionBinding(samples);

    // Logging info to be posted
    console.log(`Length of gaze ${gazeX_win.length}`);
    console.log('Fixations');
    console.log(fixations);
    console.log('Cognitive information')
    console.log({
        confusion: confusion_win,
        inattention: inattention_counter,
    });

    signaling(
        RANDOM ? '/gazeData/teacher' : '/gazeData/sync',
        {
            stuNum: studentNumber,
            fixations: fixations.length === 0 ? fixations : fixations.map(fixation => fixation.data),
            saccades: saccades,
            cognitive: {
                confusion: confusion_win,
                inattention: inattention_counter,
            }
        },
        identity
    );

    gazeX_win = [];
    gazeY_win = [];
    timestamp_win = [];
    confusion_win = [];
    inattention_counter = 0;
}

function fixationConfusionBinding (samples) {
    if (samples.x.length === 0) return [[], []];

    let [fixations, saccades] = detector.detect(samples);

    let any_confused = confusion_win.some((state) => state === 'Confused');
    let all_noface = confusion_win.every((state) => state === 'N/A');

    if (all_noface) {
        // Face is lost during past 5s, increase inattention count
        ++inattention_counter;
        if (!faceLostReported) {
            // Do not keep notifying the student, just once.
            faceLostReported = true;
            new Audio('/media/audio/facelost.mp3').play().catch(err => console.log(err));
        }
    } else if (faceLostReported) {
        // Face is back, reset flag.
        faceLostReported = false;
    }

    let lastConfusedFixation = 0;
    // Nested for loops for confusion/fixation binding
    if (any_confused && fixations.length !== 0) {
        for (const [i, state] of confusion_win.entries()) {
            if (state === 'Confused') {
                let tConfusion = (i + 1) * inferInterval + timestamp_win[0];
                for (let fixation of fixations) {
                    if (fixation.contain(tConfusion)) {
                        fixation.incConfusionCount()
                        lastConfusedFixation = fixations.indexOf(fixation);
                    } else if (fixation.start >= tConfusion) {
                        break;
                    }
                }
            }
        }
    }

    // fixations.forEach((fixation, i) => console.log(`#${i+1}:${fixation.data.start} - ${fixation.data.end}, contains ${fixation.data.confusionCount}`))

    if (fixations.length > 0 && fixations[lastConfusedFixation].confusionCount > 0) {
        console.log('Draw prompt box!')
        showPromptBox(fixations[lastConfusedFixation], patch_w, patch_h);
    } else {
        showPromptBox(fixations[lastConfusedFixation], -1, -1); // -1 means to delete
    }

    return [fixations, saccades];
}

async function signaling(endpoint, data, role) {
    // post
    let headers = { 'Content-Type': 'application/json' },
        body = JSON.stringify({ ...data, timestamp: Date.now(), role: role });

    let res = await fetch(endpoint,
        { method: 'POST', body, headers }
    );

    return res.json();
    // error will be handled by parent function, because its async, error are returned in Promise
}

// ==============================================================
// confusion detection functions
async function query() {
    // this function is not used
    let i;
    document.getElementById('plotting_svg').innerHTML = '';
    console.log(gaze_win);
    console.log(confusion_win);

    let all_same = true;
    for (i = 0; i < gaze_win.length - 1; ++i) {
        if (gaze_win[i].x !== gaze_win[i + 1].x || gaze_win[i].y !== gaze_win[i + 1].y) {
            all_same = false;
            console.log('here!!!false');
            break;
        }
    }

    // let all_confuse = confusion_win.every((state) => state === 'Confused');
    let any_confuse = confusion_win.some((state) => state === 'Confused');

    console.log(`all_same : ${all_same}, any_confuse : ${any_confuse}`);
    if (all_same && all_confuse && gaze_win.length > 0) {
        let x = gaze_win[0].x;
        let y = gaze_win[0].y;
        showPromptBox(x, y);
        console.log('draw box!!!');
    }
    gaze_win = [];
    confusion_win = [];

}

async function report(event) {
    document.getElementById('plotting_svg').innerHTML = '';

    console.log('You\'ve clicked on SVG to report confusion! @'+new Date().getTime());

    // TODO: send data to server
    // signaling(
    //     'confusion',
    //     {
    //         state: 'confused',
    //         fixation: [0,0],
    //     },
    //     identity
    // );
}

function showPromptBox(fixation, minWidth, minHeight) {
    console.log(minWidth < 0 ? 'REMOVE prompt box' : 'SHOW prompt box');

    let tFast = d3.transition()
        .duration(500);
    let tSlow = d3.transition()
        .duration(1000);

    let data = minWidth < 0 ? [] : [1]; // whatever the datum is, it is not important.
    let svg = d3.selectAll("#plotting_svg");

   svg.transition(tSlow)
    .style("left", fixation.xmin+'px')
    .style("top", fixation.ymin+'px')
    .style("width", minWidth < 0 ? 0+'px' : Math.max(minWidth, fixation.xmax - fixation.xmin)+'px')
    .style("height", minWidth < 0 ? 0+'px' : Math.max(minHeight, fixation.ymax - fixation.ymin)+'px');

    svg.selectAll('rect')
        .data(data)
        .join(
            enter => enter.append('rect')
                .attr('x', 0)
                .attr('y', 0)
                .attr('width', 0)
                .attr('height', 0)
                .attr('opacity', 0.7)
                .attr('fill', '#7584AD'),
            update => update,
            exit => exit.call(rect => rect.transition(tFast).attr("width", 0).attr("height", 0).remove())
        ).transition(tFast)
        .attr('width', Math.max(minWidth, fixation.xmax - fixation.xmin))
        .attr('height', Math.max(minHeight, fixation.ymax - fixation.ymin));

    svg.selectAll('text')
        .data(data)
        .join(
            enter => enter.append('text')
                .attr('x', 0)
                .attr('y', 0)
                .attr('stroke', 'black')
                .style("font-size", 14)
                .html("<tspan dx='5' dy='20'>Confused AROUND?</tspan><tspan x='5' dy='20'>Click to report.</tspan>"),
            update => update,
            exit => exit.remove()
        );
}

async function showCoords(event) {
    let cX = event.clientX;
    let cY = event.clientY;
    gazeX = cX;//GazeData.GazeX;
    gazeY = cY;//GazeData.GazeY;
    let gaze = document.getElementById("gaze");
    gaze.style.display = 'block'
    cX -= gaze.clientWidth / 2;
    cY -= gaze.clientHeight / 2;
    gaze.style.left = cX + "px";
    gaze.style.top = cY + "px";
    console.log('clicked!!!');
}

async function stateInference() {
    if (collecting === 0 && totalConfused === 0 && totalNeutral === 0) {
        let result = await reportState(INFERENCE, 0);
        document.getElementById('status_bar').innerHTML = 'Prediction result: ' + result;

        let containerHeight = document.getElementById('container').offsetHeight;
        let containerWidth = document.getElementById('container').offsetWidth;
        patch_h = containerHeight / grid_h;
        patch_w = containerWidth / grid_w;

        let x_ = Math.floor((gazeX - document.getElementById('container').offsetLeft) / patch_w);
        let y_ = Math.floor((gazeY - document.getElementById('container').offsetTop) / patch_h);
        // console.log(gazeX, gazeY, x_, y_);
        // gaze_win.push({ x: x_, y: y_ });
        confusion_win.push(result);

        secondCounter++;
    }

}

async function dataCollecting() {
    // on server side, label CONFUSED(1) is confused expressions, label NOTCOLLECTING(0) is neutral
    let label = collecting === CONFUSED ? CONFUSED : NOTCOLLECTING;
    let result = await reportState(COLLECTION, label)
    if (collecting === CONFUSED) { // collecting confusion
        totalConfused -= 1;
        document.getElementById('collectDescription').innerHTML = totalConfused.toString() + ' confusion frames left...';
        if (totalConfused === 0) {
            collecting = NOTCOLLECTING;

            document.getElementById("collectTitle").innerText = "Please make no expression.";
            document.getElementById("collectDescription").innerText = "Press \"Collect\" if you are ready.";
            document.getElementById("collectBtn").setAttribute("onclick", "collecting = NEUTRAL;");

            document.getElementById('confused_btn').disabled = false;
            document.getElementById('neutral_btn').disabled = false;
        }
    } else { // collecting neutral
        totalNeutral -= 1;
        document.getElementById('collectDescription').innerHTML = totalNeutral.toString() + ' neutral frames left...';
        if (totalNeutral === 0) {
            collecting = NOTCOLLECTING;

            closeModal("dataCollectModal");
            syncCountdown();

            document.getElementById('confused_btn').disabled = false;
            document.getElementById('neutral_btn').disabled = false;
        }
    }
}

async function reportState(stage, label) {
    // after data collection stage
    if (stage === COLLECTION) {
        // During collection stage, collected data will be shown in modal dialogue.
        collectCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    } else if (reporting) {
        return null
    }
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    let base64ImageData = canvasElement.toDataURL();
    let ver = 0;
    if (stage === INFERENCE) {
        ver = model_ver;
    } else if (stage === INCREMENT) {
        ver = ++model_ver;
    }
    let data = {
        img: base64ImageData, 
        stage: stage, 
        label: label, 
        // username: 1,
        ver: ver,
        username: userInfo['number'],
        frameId: label ? totalConfused : totalNeutral,
    };
    let result = null;
    try {
        if (stage === COLLECTION) {
            // fetch('http://127.0.0.1:8000/detection', { // 172.20.16.10
            fetch('/detection', {
                method: 'POST',
                body: JSON.stringify(data),
                referrerPolicy: "origin",
            })
        } else {
            reporting = true;
            // await fetch('http://127.0.0.1:8000/detection', { // 172.20.16.10
            await fetch('/detection', {
                method: 'POST',
                body: JSON.stringify(data),
                referrerPolicy: "origin",
            }).then(
                response => response.json()
            ).then(data => {
                console.log(data)
                result = data.body.result;
            })
            reporting = false;
        }
    } catch (err) {
        console.error('ERROR:', err);
    }

    return result;
}

async function reportNeutral() {
    if (collecting !== NOTCOLLECTING) {
        console.log('collecting data, quit');
    } else {
        if (totalNeutral === total) {
            collecting = NEUTRAL; // Neutral: 2
            document.getElementById('confused_btn').disabled = true;
            document.getElementById('neutral_btn').disabled = true;
            // console.log('already finished data collection, quit');
        } else if (totalNeutral === 0 && totalConfused === 0) {
            let result = await reportState(INCREMENT, 0); // stage: 2 (single report), neutral label: 0
            console.log(result)
            if (result === 'success') {
                console.log('data collected!');
            } else {
                console.log('data missed!', result);
            }
        } else {
            console.log('do nothing...');
        }
    }

}

async function reportConfusion() {
    if (collecting !== NOTCOLLECTING) {
        console.log('collecting data, quit');
    } else {
        if (totalConfused === total) {
            collecting = CONFUSED; // Confusion: 1
            document.getElementById('confused_btn').disabled = true;
            document.getElementById('neutral_btn').disabled = true;
            // console.log('already finished data collection, quit');
        } else if (totalNeutral === 0 && totalConfused === 0) {
            let result = await reportState(INCREMENT, 1); // stage: 2 (single report), confusion label: 1
            if (result === 'success') {
                console.log('data collected!');
            } else {
                console.log('data missed!', result);
            }
        } else {
            console.log('do nothing...');
        }
    }
}
// ==============================================================
// confusion detection functions

function reportInattention() {
    if (document.visibilityState === 'hidden') {
        lastHiddenTimestamp = new Date().getTime();
        setTimeout(() => {
            if (lastHiddenTimestamp !== 0 && !hiddenReported) {
                hiddenReported = true; // To prevent duplicated alert
                new Audio('/media/audio/alert.mp3').play().catch(err => console.log(err));
            }
        }, updateInterval * inferInterval)
    } else if (document.visibilityState === 'visible') {
        // Student returns.
        // Remove alert by clean lastHiddenTimestamp
        lastHiddenTimestamp = 0;
        hiddenReported = false;
    }
}
