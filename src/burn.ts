import Router from "worker-loader!./router";
import { weightLength, weightTraffic } from "./weightFunctions";

let config = {
    trafficWeight: "linear",
    distanceWeight: "square",
    nodeCount: 30,
    packetSpawnChance: 1 / 60,
    addRemoveNodes: true,
    addRemoveChance: 1 / 100,
    packetOfDeath: false,
    deadNodeTTL: 10 * 60
}

// Globals
let nav: RouteInfo = new Map();
let frameCount = 0;
let Scene: Scene = null;
let hubLookup: Map<number, Hub> = null;
let milisPerFrame = 0;
let packets: Set<Packet> = new Set();

let getId = (function() {
    let id = 0;
    return function getId() { return id += 1 };
}());

function randomSelection<T>(collection: Iterable<T>): T {
    let result = null;
    let count = 0;
    for (let curr of collection) {
        if (Math.random() < 1/++count)
            result = curr;
    }
    return result;
}

function randomLiveSelection<T>(collection: Iterable<Hub>): Hub {
    let target: Hub;
    do {
        target = randomSelection(Scene[0].values());
    } while (target.isDead || !nav.has(target.id))
    return target;
}

// Data Types
export type RouteInfo = Map<number, Map<number, number | null>>;

class Packet {
    readonly id: number;
    readonly isPOD: boolean;
    target: Hub;
    speed: number;
    
    /** True if packet is currently travelling from A to B */
    TAToB: boolean;
    /** Float in the range 0<=x<1 indicating progress along current Pipe*/
    TProgress: number;
    
    constructor(target: Hub, isPOD = false) {
        this.id = getId();
        this.target = target;
        this.isPOD = isPOD;
        this.speed = (Math.random() * 1.5) + 0.5;
        this.TAToB = null;
        this.TProgress = null;
    }
}

class Pipe {
    readonly ends: [Hub, Hub];
    readonly inflight: Set<Packet>;
    _weight: number;
    /** Note that _length is in units squared */
    _length: number;

    constructor(a: Hub, b: Hub) {
        this.ends = [a, b];
        this._weight = 1;
        this.inflight = new Set();
        
        let dx = Math.abs(a.position[0] - b.position[0]);
        let dy = Math.abs(a.position[1] - b.position[1]);
        this._length = dx**2+dy**2;
    }
    
    incrementWeight(): void {
        if (this.ends[0].isDead || this.ends[1].isDead)
            return;

        this._weight += 1;
    }
    
    decrementWeight() : void {
        // this formula stolen verbatim from chemicalburn,
        this._weight = ((this._weight - 1) * 0.99) + 1;
    }

    traffic(): number {
        let w = this._weight;
        return weightTraffic(w, config.trafficWeight);
    }

    distance(): number {
        let l = this._length;
        return weightLength(l, config.distanceWeight);
    }
    
    cost(): number {
        if (this.ends[0].isDead || this.ends[1].isDead)
            return Number.MAX_VALUE;
        else
            return this.distance() / this.traffic();
    }
    
    receive(p: Packet, destination: Hub): void {
        if (!(destination === this.ends[0] || destination === this.ends[1]))
            throw "Requested destination not available";
            
        p.TAToB = destination === this.ends[1];
        p.TProgress = 0;
        this.inflight.add(p);
        this.incrementWeight();
    }

    step(): void {
        const delivered: Set<Packet> = new Set();
        // loop through all the inflight packets, updating their status and making note
        // of those which are complete;
        for (let packet of this.inflight) {
            const newProgress = packet.TProgress + packet.speed * this.traffic() / this.distance();
            
            if (newProgress < 1)
                packet.TProgress = newProgress;
            else
                delivered.add(packet);
        }
        
        for (let packet of delivered) {
            this.inflight.delete(packet);
            if (packet.TAToB)
                this.ends[1].receive(packet);
            else
                this.ends[0].receive(packet);
        }
        
        this.decrementWeight();
    }
}

export class Hub {
    // x, y coordinates in world-space (i.e. in the range [0-1])
    readonly position: [number, number];
    readonly id: number;
    readonly neighbors: Map<Hub, Pipe>;
    isDead: boolean;
    
    constructor(x: number, y: number) {
        this.position = [x, y]
        this.id = getId();
        this.neighbors = new Map();
        this.isDead = false;
    }
    
    receive(p: Packet): void {
        if (p.isPOD)
            this.isDead = true;

        if (p.target === this) {
            if (p.isPOD) {
                p.target = randomLiveSelection(Scene[0].values());
            } else {
                packets.delete(p);
                return;
            }
        }

        if (this.neighbors.size === 0)
            throw "No links";
            
        const nextHop = hubLookup.get(nav.get(p.target.id).get(this.id));
        let target = this.neighbors.get(nextHop);

        if (target !== undefined)
            target.receive(p, nextHop);
    }
}


// Program
type Scene = [Map<number, Hub>, Pipe[]]

function generateHub(hubs: Map<number, Hub>, pipes: Pipe[], width, height): void {
    function addNeighbor(a: Hub, b: Hub): void {
        if (a.neighbors.has(b))
            return;
        
        const p = new Pipe(a, b);
        pipes.push(p);
        a.neighbors.set(b, p);
        b.neighbors.set(a, p);
    }
    
    let x = Math.floor(Math.random() * width);
    let y = Math.floor(Math.random() * height);
    let newHub = new Hub(x, y);
    for (let x of hubs.values()) {
        addNeighbor(x, newHub);
        addNeighbor(newHub, x);
    }
    hubs.set(newHub.id, newHub);
}

function generateScene(numHubs: number, width: number, height: number): Scene {
    const hubs: Map<number, Hub> = new Map();
    const pipes: Pipe[] = [];
    
    for (let i = 0; i < numHubs; i++) {
        generateHub(hubs, pipes, width, height);
    }
    return [hubs, pipes];
}

function randInt(min: number, max: number): number {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    return Math.floor(Math.random() * (max - min)) + min;
}

let intToColor = (function() {
    const colorTable = new Map<number, string>();
    return function intToColor(i: number): string {
        if (colorTable.has(i))
            return colorTable.get(i);
        else {
            // turns out that random rgb values don't *look* random!
            // so instead randomize hue value of hsl color
            const colorString = `hsl(${randInt(0,360)},100%,50%)`;
            colorTable.set(i, colorString);
            return colorString;
        }
    }
})();

function render(ctx: CanvasRenderingContext2D, scene: Scene, height: number, width: number): void {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
    
    const [hubs, pipes] = scene;
    
    for (let pipe of pipes) {
        let lineWidth = Math.min(6, (pipe.traffic() - 1) / 24)
        let p1 = pipe.ends[0].position;
        let p2 = pipe.ends[1].position;

        if (lineWidth >= 1/255) {
            if (pipe.ends[0].isDead || pipe.ends[1].isDead)
                ctx.strokeStyle = "red";
            else 
                ctx.strokeStyle = "white";

            ctx.lineWidth = lineWidth;

            let [x1, y1] = p1;
            let [x2, y2] = p2;

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }


        for (let packet of pipe.inflight.keys()) {
            function drawPacket(p1: [number, number], p2: [number, number]) {
                let [x1, y1] = p1;
                let dx = (p2[0] - p1[0]) * packet.TProgress;
                let dy = (p2[1] - p1[1]) * packet.TProgress;
                if (packet.isPOD) {
                    const packetSize = 8;
                    const r = packetSize / 2;
                    ctx.fillStyle = "red";
                    ctx.beginPath();
                    ctx.moveTo(x1+ dx, y1 + dy - r);
                    ctx.lineTo(x1 + dx + r, y1 + dy + r);
                    ctx.lineTo(x1 + dx - r, y1 + dy + r);
                    ctx.fill();
                } else {
                    const packetSize = 4;
                    const r = packetSize / 2;
                    ctx.fillStyle = intToColor(packet.target.id);
                    ctx.fillRect((x1 + dx) - r,
                        (y1 + dy) - r,
                        packetSize, packetSize);
                }
            }

            const aToB = packet.TAToB;
            const progress = packet.TProgress;
            if (aToB) {
                drawPacket(p1, p2);
            } else {
                drawPacket(p2, p1);
            }
        }
    }
    
    const hubsize = 7;
    for (let h of hubs.values()) {
        if (h.isDead)
            ctx.fillStyle = "red";
        else
            ctx.fillStyle = "white";

        let [x, y] = h.position;
        ctx.fillRect(x - (hubsize/2), y - (hubsize/2), hubsize, hubsize);
    }

    ctx.fillStyle = "white";
    ctx.fillText(Math.round(1000/milisPerFrame).toString(), 0, 8);
}

function main() {
    let params = new URLSearchParams(document.location.search);
    for (let k in config) {
        if (params.has(k)) {
            try {
                config[k] = JSON.parse(params.get(k));
            } catch (e) {
                config[k] = params.get(k);
            }
        } else {
            params.set(k, config[k].toString());
        }
    }
    history.replaceState(0, document.title, "?"+params.toString());

    const height = window.innerHeight;
    const width = window.innerWidth;

    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    canvas.height = height;
    canvas.width = width;

    const ctx = canvas.getContext('2d');
    ctx.font = '8px monospace';

    Scene = generateScene(config.nodeCount, width, height);
    const [hubs, pipes] = Scene;
    hubLookup = hubs;
    let packageOfDeath: Packet = null;
    let killList: number[] = [];
    
    let started = false;
    let requestRefresh = false;
    let lastFrame = performance.now();
    
    render(ctx, Scene, height, width);

    let walkingDead: Map<number, number> = new Map();
    function renderStep() {
        // generate package of death
        if (frameCount == 0 && config.packetOfDeath) {
            packageOfDeath = new Packet(randomSelection(hubs.values()), true);
            packets.add(packageOfDeath);
            randomSelection(hubs.values()).receive(packageOfDeath);
        }

        // remove dead nodes
        for (let [hid, t] of walkingDead) {
            if (frameCount - t > config.deadNodeTTL) {
                let h = hubLookup.get(hid);
                killList.push(hid);
                hubs.delete(hid);

                for (let [n, p] of h.neighbors) {
                    h.neighbors.delete(n);
                    n.neighbors.delete(h);

                    let pos = pipes.indexOf(p);
                    pipes.splice(pos, 1);
                }
            }
        }
        for (let k of killList)
            walkingDead.delete(k);
        killList.length = 0;

        // advance all packets
        for (let p of pipes)
            p.step();

        // add new packages
        for (let h of hubs.values()) {
            if (h.isDead && !walkingDead.has(h.id)) {
                walkingDead.set(h.id, frameCount);
                continue;
            }

            // test nav to make sure we only route to and from packets which we
            // have routing info on
            if (!nav.has(h.id))
                continue;

            if (Math.random() < config.packetSpawnChance) {
                let target = randomLiveSelection(hubs.values());
                let p = new Packet(target);
                packets.add(p);
                h.receive(p);
            }
        }

        // add and remove nodes
        if (config.addRemoveNodes) {
            if (packageOfDeath)
                packageOfDeath.speed = ((hubs.size - walkingDead.size) / config.nodeCount) ** 2;
            let popDelta = (config.nodeCount - Scene[0].size) / config.nodeCount;
            let roll = Math.random();
            let addChance = config.addRemoveChance / 2;
            if (roll < addChance + addChance * popDelta) {
                generateHub(Scene[0], Scene[1], width, height)
            } else if (roll < config.addRemoveChance) {
                let hub = randomLiveSelection(hubs.values());
                hub.isDead = true;
            }
        }

        if (requestRefresh) {
            router.postMessage([hubs, null]);
            requestRefresh = false;
        }

        render(ctx, Scene, height, width);
        window.requestAnimationFrame(renderStep);
        frameCount += 1;
        let frameTime = performance.now();
        milisPerFrame = (milisPerFrame * 19 + (frameTime - lastFrame)) / 20;
        lastFrame = frameTime;
    }

    let router = new Router();
    router.onmessage = function(e) {
        nav = e.data;
        requestRefresh = true;

        if (!started) {
            started = true;
            renderStep();
        }
    }

    router.postMessage([hubs, config]);
    
}

main()