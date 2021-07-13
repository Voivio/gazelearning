const margin = ({top: 20, right: 30, bottom: 40, left: 40})
const window_h = document.documentElement.clientHeight,
    window_w = document.documentElement.clientWidth;
const height = 0.5 * window_h,
    width = window_w;
let progress_width;
const animation_time = 5000; // 5 seconds
const updateInterval = 5000;

const TEST = false;

class Ratio {
    constructor(confusion_ratio, inattention_ratio, time) {
        this.knowledge = 1 - confusion_ratio;
        this.attention = 1 - inattention_ratio;
        this.time = new Date(time);
    }
}

let test_data = new Array(100);
const current = Date.now();
for (let i = 0; i < test_data.length; ++i) {
    test_data[i] = new Ratio(Math.random(), Math.random(), new Date(current+i*1000));
}

window.addEventListener("load", (event)=>{
    // Show progress bar
    openModal("progress-modal")

    // Add svg elements
    d3.select("#container").insert("svg").attr("id", "line_chart");
    d3.select("#progress-bar-container").insert("svg").attr("id", "progress-bar");

    let svg = d3.select("#line_chart")
        // .style('left', xOffset)
        // .style('top', yOffset)
        .attr("width", width)
        .attr("height", height)
        .attr("font-family", "sans-serif")
        .attr("font-size", 14);
    console.log(`Summary SVG set. Shape ${height} x ${width}.`);

    progress_width = document.getElementById("progress-modal-title").getBoundingClientRect().width;
    let progressBar = d3.select("#progress-bar")
        // .style('left', xOffset)
        // .style('top', yOffset)
        .attr("width", progress_width)
        .attr("height", 50);
    initProgressBar(progressBar);
    console.log(`Progress bar SVG set.`);

    request()
        .then(info_map => process(info_map))
        .then(data => {
            closeModal("progress-modal");
            viz(data);
        })
        .catch(err => console.error(err));
});

async function request() {
    let res = await fetch('/studentInfo', {
        method: 'GET',
    });
    let stuNums = await res.json(); // string!

    let info_map = new Map();
    for (let [index, stuNum] of Object.entries(stuNums)) {
        // Process bar
        console.log(`Fetching info of ${stuNum}, ${+index+1} / ${stuNums.length}`);
        updateProgressBar( (+index+1)/stuNums.length,1)
        // Fetch info of stuNum
        let res = await fetch(`/studentInfo/${stuNum}`, {
            method: 'GET',
        });
        let info = await res.text();
        info = info.split('|');
        info.pop();

        for (let text of info) {
            try{
                JSON.parse(text)
            } catch (err) {
                console.log(text);
                console.error(err);
            }
        }

        info_map.set(stuNum, info.map(JSON.parse));
    }

    return info_map;
}

async function process(info_map) {
    if (info_map.size === 0) {
        console.warn('No student info.')
        return []
    }

    let confusion_rate = 0,
        inattention_rate = 0,
        data = [],
        slot_count = 0, // Count time slots, which is actually data.length
        cursor = new Map(),
        length = new Map();
    const start = TEST ? Date.now() : getStartTime(info_map);

    for (let [stuNum, info] of info_map.entries()) {
        cursor.set(stuNum, 0);
        length.set(stuNum, info.length);
    }
    const total_length =  d3.sum(length.values());

    let times = 0, update = 10; // Every 10 times update the progress bar
    while (true){
        // Process bar
        if (times % update === 0) {
            let cur = d3.sum(cursor.values());
            updateProgressBar( cur/total_length,2)
        }

        let count = 0;
        for (let stuNum of cursor.keys()) {
            // Have reached the end？
            let ptr = cursor.get(stuNum);
            if (ptr >= length.get(stuNum)) continue
            // Within time range?
            // No info will be smaller than start
            if ( !TEST && info_map.get(stuNum)[ptr]["timestamp"] > start + (slot_count+1)*updateInterval ) continue
            // cogInfo {confusion: string[], inattention: number}
            let cogInfo = info_map.get(stuNum)[ptr]["cognitive"];
            if (cogInfo.inattention > 0) ++inattention_rate;
            if (cogInfo.confusion.some((state) => state === 'Confused')) ++confusion_rate;
            // Manage state variables
            ++count;
            cursor.set(stuNum, ptr+1);
        }

        if (count === 0) {
            // All reach end
            break
        } else {
            data.push(new Ratio(confusion_rate/count, inattention_rate/count, start + slot_count*updateInterval));
            ++slot_count;
            confusion_rate = 0;
            inattention_rate = 0;
        }
    }

    updateProgressBar(1,2)
    return data;
}

function viz(data) {
    let svg = d3.select("#line_chart")
    // Define constants
    const keys = ['Knowledge Ratio', 'Attention Ratio'],
        color = d3.scaleOrdinal()
            .domain(keys)
            .range(d3.schemeSet2);

    // Convert data to positions
    const x = d3.scaleTime()
        .domain(d3.extent(data, d => d.time.getTime()))
        .range([margin.left, width - margin.right])
    const y = d3.scaleLinear()
        .domain([0, 1])
        .range([height - margin.bottom, margin.top]);

    // Plot axes
    const gx = svg.append("g")
        .call(xAxis, x);
    const gy = svg.append("g")
        .call(yAxis, y);

    // Plot lines
    let paths = [];
    for (let key of keys) {
        let property = key.split(' ')[0].toLowerCase();
        let line = d3.line().x(d => x(d.time)).y(d => y(d[property]));
        paths.push(
            svg.append("path")
                .attr("id", key)
                .attr("fill", "none")
                .attr("stroke", color(key))
                .attr("stroke-width", 1.5)
                .attr("stroke-miterlimit", 1)
                .attr("stroke-dasharray", function () {
                    const length = this.getTotalLength();
                    return `0,${length}`
                })
                .attr("d", line(data))
        );
    }

    // Animation
    const t = d3.transition()
        .duration(animation_time)
        .ease(d3.easeLinear);
    for (let path of paths) {
        path.transition(t).attrTween("stroke-dasharray", function () {
            const length = this.getTotalLength();
            return d3.interpolate(`0,${length}`, `${length},${length}`);
        });
    }

    // Plot legend (no built-in functions).
    // So I plot legend together with x axis title in order to avoid collision
    titleAndLegend(svg, keys, color);
}

function xAxis(g, scale) {
    return g
        .attr("transform", `translate(0,${height - margin.bottom})`)
        .call(d3.axisBottom(scale).ticks(width / 80).tickSizeOuter(0))
}

function yAxis(g, scale) {
    return g.attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(scale).ticks(height / 40))
        .call(g => g.select(".domain").remove())
}

function getStartTime(info_map) {
    let starts = [];
    for (let info of info_map.values()) {
        starts.push(info[0].timestamp);
    }
    return Math.min(...starts)
}

function titleAndLegend(svg, keys, color) {
    // Plot legend (no built-in functions).
    // So I plot legend together with x axis title in order to avoid collision
    // Add X axis label:
    svg.append("text")
        .attr("text-anchor", "end")
        .attr("x", width - margin.right)
        .attr("y", height - 15)
        .text("Time");

    // Y axis label:
    svg.append("text")
        .attr("text-anchor", "end")
        .attr("transform", "rotate(-90)")
        .attr("y", margin.left / 2)
        .attr("x", -margin.top)
        .text("Ratio")

    // Add one dot in the legend for each name.
    svg.selectAll("dots")
        .data(keys)
        .enter()
        .append("circle")
        .attr("cx",function (d, i) {
            return margin.left + i * (120 + 14)
        })
        // margin.left is where the first dot appears
        // 120 is the distance between dots. Actually width of legend names.
        // 14 is 2 * radius
        .attr("cy", height - 15)
        // 15 is a hard-coded offset
        .attr("r", 7)
        .style("fill", d => color(d));

    // Add one dot in the legend for each name.
    svg.selectAll("labels")
        .data(keys)
        .enter()
        .append("text")
        .attr("x", function (d, i) {
            return margin.left + (i+1) * 14 + i * 120
        })
        // margin.left + 14 (2*radius) is where the first dot appears
        // 120 is the distance between dots. Actually width of legend names.
        .attr("y",  height - 15)
        // 15 is a hard-coded offset
        .text(d => d)
        .attr("text-anchor", "left")
        .style("alignment-baseline", "middle");
}

function initProgressBar(progressBarSVG) {
    // Add background rectangle
    progressBarSVG.append("rect")
        .attr('class', 'bg-rect')
        .attr('rx', 10)
        .attr('ry', 10)
        .attr('fill', '#ededed')
        .attr('height', 15)
        .attr('width', progress_width)
        .attr('x', 0)
        .attr('y', 20);
    // Add front rectangle
    progressBarSVG.append('rect')
        .attr('class', 'progress-rect')
        .attr('fill', 'white')
        .attr('height', 15)
        .attr('width', 0)
        .attr('rx', 10)
        .attr('ry', 10)
        .attr('x', 0)
        .attr('y', 20);
}

const ratio2color = d3.scaleLinear().domain([0,1])
    .range(["white", "#06d6a0"]);

function updateProgressBar(ratio, stage) {
    // Define two stages, first stage is requesting info
    // second stage is processing info
    const weight = 0.8;
    if (stage === 1) {
        ratio = ratio * weight;
    } else {
        ratio = weight + ratio * weight;
    }
    d3.select('.progress-rect')
        .transition()
        .duration(150)
        .attr('fill', ratio2color(ratio))
        .attr('width', progress_width*ratio);
}

// Modal window
function openModal(modalId) {
    // document.getElementById("backdrop").style.display = "block"
    document.getElementById(modalId).style.display = "block"
    document.getElementById(modalId).className += "show"
}
function closeModal(modalId) {
    // document.getElementById("backdrop").style.display = "none"
    document.getElementById(modalId).style.display = "none"
    document.getElementById(modalId).className += document.getElementById(modalId).className.replace("show", "")
}