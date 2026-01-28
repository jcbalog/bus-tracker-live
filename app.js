import { 
    auth, db, 
    signInAnonymously, 
    signInWithPopup, 
    googleProvider, 
    microsoftProvider,
    PhoneAuthProvider,
    PhoneMultiFactorGenerator,
    RecaptchaVerifier,
    multiFactor,
    collection, doc, setDoc, getDoc, onSnapshot, deleteDoc 
} from './firebase-config.js';

let map;
let routeData = {}; 
let busMarkers = {};
let watchId = null; 
let simulationInterval = null;
let currentUser = null; 
let verificationId = null;
let mfaResolver = null; 
let isOnShift = false;
let busState = { nextIndex: 1, speed: 0, lat: 0, lng: 0, pax: 0 };
let wakeLock = null;

// Traffic Zones for Simulation logic
const trafficZones = [
    { lat: 14.4630, lng: 120.9730, radius: 0.015, speedLimit: 15 }, // Talaba
    { lat: 14.4050, lng: 120.8750, radius: 0.010, speedLimit: 20 }, // Tejero
    { lat: 14.3250, lng: 120.9380, radius: 0.015, speedLimit: 25 }  // SM Dasma
];

async function init() {
    setupUIListeners(); // Initialize UI Listeners Immediately

    try {
        const response = await fetch('./routes.json');
        const data = await response.json();
        routeData = data.routes;
        initMap();
        
        auth.onAuthStateChanged((user) => {
            if (!user) {
                signInAnonymously(auth).catch(e => console.log("Anon Auth Error", e));
            } else {
                checkUserProfile(user);
            }
        });

        subscribeToBuses();
        setupRecaptcha();
    } catch (e) {
        console.error("Initialization error:", e);
    }
}

function initMap() {
    map = L.map('map', { 
        zoomControl: false, 
        attributionControl: false 
    }).setView([14.39, 120.90], 11);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
    }).addTo(map);

    document.getElementById('map').style.opacity = 1;

    // Draw Routes
    Object.values(routeData).forEach(r => {
        L.polyline(r.path, { 
            color: r.color, 
            opacity: 0.3, 
            weight: 2,
            lineCap: 'round'
        }).addTo(map);
    });

    // Start Live Feed
    subscribeToBuses();
}

function populateDropdowns(companies) {
    const compSelects = [document.getElementById('reg-d-company'), document.getElementById('reg-op-company')];
    const routeSelect = document.getElementById('shift-route-select');
    
    compSelects.forEach(sel => {
        companies.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.innerText = c;
            sel.appendChild(opt);
        });
    });

    Object.entries(routeData).forEach(([id, r]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.innerText = r.name;
        routeSelect.appendChild(opt);
    });
}

// --- AUTHENTICATION & FLOW ---
window.handleSocialLogin = async (providerName, role) => {
    try {
        const provider = providerName === 'google' ? googleProvider : microsoftProvider;
        const result = await signInWithPopup(auth, provider);
        checkUserRegistration(result.user, role);
    } catch (error) {
        alert("Login Failed: " + error.message);
    }
};

window.logout = async () => {
    if (currentShift && currentRole === 'driver') await endShift();
    await signOut(auth);
    location.reload();
};

function setupAuthListeners() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) return; // Wait for explicit login action for drivers/operators
        
        // If already logged in, check DB for role and profile
        const userDoc = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid));
        
        if (userDoc.exists()) {
            currentUser = { uid: user.uid, ...userDoc.data() };
            currentRole = currentUser.role;
            
            if (currentRole === 'driver') loadDriverDashboard();
            else if (currentRole === 'operator') loadOperatorDashboard();
        } else {
            // User authenticated but not in DB yet (Needs Registration)
            // We wait for the specific role flow trigger from handleSocialLogin logic
        }
    });
}

async function checkUserRegistration(user, targetRole) {
    const userRef = doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid);
    const snap = await getDoc(userRef);

    if (snap.exists()) {
        const data = snap.data();
        if (data.role !== targetRole) {
            alert(`Error: You are registered as a ${data.role}, not a ${targetRole}.`);
            signOut(auth);
            return;
        }
        currentUser = { uid: user.uid, ...data };
        currentRole = targetRole;
        if(targetRole === 'driver') loadDriverDashboard();
        else loadOperatorDashboard();
    } else {
        // Show Registration Form
        if (targetRole === 'driver') {
            document.getElementById('driver-login-panel').classList.add('hidden');
            document.getElementById('driver-reg-panel').classList.remove('hidden');
        } else {
            document.getElementById('op-login-panel').classList.add('hidden');
            document.getElementById('op-reg-panel').classList.remove('hidden');
        }
    }
}

// --- REGISTRATION ---
async function registerUser(role, name, company, dob = null) {
    const user = auth.currentUser;
    if (!user) return;

    const userData = {
        name,
        company,
        role,
        email: user.email,
        createdAt: serverTimestamp()
    };
    if (dob) userData.dob = dob;

    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'users', user.uid), userData);
    currentUser = { uid: user.uid, ...userData };
    currentRole = role;
    
    if (role === 'driver') loadDriverDashboard();
    else loadOperatorDashboard();
}

// --- DRIVER LOGIC ---
function loadDriverDashboard() {
    // Hide Login/Reg
    document.getElementById('driver-login-panel').classList.add('hidden');
    document.getElementById('driver-reg-panel').classList.add('hidden');
    
    // Check if already in active shift or pending
    checkDriverStatus();
}

function checkDriverStatus() {
    // Check for Active Shift
    const activeRef = doc(db, 'artifacts', appId, 'public', 'data', 'active_buses', currentUser.uid);
    onSnapshot(activeRef, (snap) => {
        if (snap.exists()) {
            currentShift = snap.data();
            showDriverScreen('active');
            startGPS(); // Resume GPS if page refreshed during shift
        } else {
            // Check for Pending Request
            const q = query(
                collection(db, 'artifacts', appId, 'public', 'data', 'shift_requests'),
                where('driverUid', '==', currentUser.uid),
                where('status', '==', 'pending')
            );
            
            // Single fetch or listener? Listener is better for real-time approval
            const unsubscribe = onSnapshot(q, (snapshot) => {
                if (!snapshot.empty) {
                    showDriverScreen('pending');
                } else {
                    // Check if request was rejected (not pending, not active) -> Setup
                    // For simplicity, if no active and no pending, go to setup
                    if(!currentShift) showDriverScreen('setup');
                }
            });
        }
    });
}

function showDriverScreen(screen) {
    ['setup', 'pending', 'active'].forEach(s => {
        document.getElementById(`driver-${s}-panel`).classList.add('hidden');
    });
    if(screen === 'active') document.getElementById('driver-dashboard').classList.remove('hidden');
    else {
        document.getElementById('driver-dashboard').classList.add('hidden');
        document.getElementById(`driver-${screen}-panel`).classList.remove('hidden');
    }

    if (screen === 'active' && currentShift) {
        document.getElementById('dash-driver-name').innerText = currentUser.name;
        document.getElementById('dash-bus-no').innerText = currentShift.busNumber;
        document.getElementById('dash-plate').innerText = currentShift.plateNumber;
        updateRouteDisplay();
    }
}

async function requestShift() {
    const busNo = document.getElementById('shift-bus-no').value;
    const plate = document.getElementById('shift-plate').value;
    const routeId = document.getElementById('shift-route-select').value;

    if (!busNo || !plate || !routeId) {
        alert("Please fill all fields.");
        return;
    }

    const reqData = {
        driverUid: currentUser.uid,
        driverName: currentUser.name,
        company: currentUser.company,
        busNumber: busNo,
        plateNumber: plate,
        routeId: routeId,
        status: 'pending',
        timestamp: serverTimestamp()
    };

    await setDoc(doc(collection(db, 'artifacts', appId, 'public', 'data', 'shift_requests')), reqData);
    // UI updates automatically via listener in checkDriverStatus
}

async function startShiftFromApproval(requestData) {
    // This function runs when Operator approves. 
    // Logic: Operator approval creates the 'active_buses' doc. 
    // Driver listener detects 'active_buses' doc and calls showDriverScreen('active').
}

// GPS & Telemetry
function startGPS() {
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(l => wakeLock = l).catch(() => {});
    
    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const speed = (pos.coords.speed || 0) * 3.6; // km/h
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                
                busState = { speed, lat, lng };
                updateBusLocation(lat, lng, speed);
                
                // Update UI Telemetry
                document.getElementById('telemetry-speed').innerText = Math.round(speed);
                // ETA logic would go here (simplified for now)
            },
            (err) => console.warn("GPS Error", err),
            { enableHighAccuracy: true }
        );
    }
}

async function updateBusLocation(lat, lng, speed) {
    if (!currentShift) return;
    const busRef = doc(db, 'artifacts', appId, 'public', 'data', 'active_buses', currentUser.uid);
    await updateDoc(busRef, {
        lat, lng, speed,
        lastUpdate: Date.now()
    });
}

window.endShift = async () => {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    if (wakeLock) wakeLock.release();
    
    const busRef = doc(db, 'artifacts', appId, 'public', 'data', 'active_buses', currentUser.uid);
    await deleteDoc(busRef);
    currentShift = null;
    showDriverScreen('setup');
};

// Route Logic
document.getElementById('btn-arrive-terminal').addEventListener('click', async () => {
    if (!currentShift) return;
    
    // Toggle Direction
    const isReverse = !currentShift.isReverse;
    const busRef = doc(db, 'artifacts', appId, 'public', 'data', 'active_buses', currentUser.uid);
    
    await updateDoc(busRef, { isReverse });
    currentShift.isReverse = isReverse; // Optimistic update
    updateRouteDisplay();
});

function updateRouteDisplay() {
    if(!currentShift) return;
    const route = routeData[currentShift.routeId];
    const origin = route.name.split(' - ')[0];
    const dest = route.name.split(' - ')[1].split('(')[0].trim(); // Rough parse
    
    const display = currentShift.isReverse ? `${dest} -> ${origin}` : `${origin} -> ${dest}`;
    document.getElementById('dash-route-name').innerText = display;
    
    // Update destination in DB for passengers? Actually we can compute it on read
}

// --- OPERATOR LOGIC ---
function loadOperatorDashboard() {
    document.getElementById('op-login-panel').classList.add('hidden');
    document.getElementById('op-reg-panel').classList.add('hidden');
    document.getElementById('operator-dashboard').classList.remove('hidden');
    document.getElementById('op-dash-name').innerText = `${currentUser.company} COMMAND`;

    listenToShiftRequests();
    listenToFleet();
}

function listenToShiftRequests() {
    const q = query(
        collection(db, 'artifacts', appId, 'public', 'data', 'shift_requests'),
        where('company', '==', currentUser.company),
        where('status', '==', 'pending')
    );

    onSnapshot(q, (snap) => {
        const list = document.getElementById('op-pending-list');
        document.getElementById('pending-count').innerText = snap.size;
        list.innerHTML = '';

        if(snap.empty) {
            list.innerHTML = '<div class="text-center text-gray-600 text-[10px] font-mono py-4">NO PENDING TRANSMISSIONS</div>';
            return;
        }

        snap.forEach(docSnap => {
            const req = docSnap.data();
            const div = document.createElement('div');
            div.className = 'bg-slate-900/80 p-3 rounded border border-gray-700 flex justify-between items-center';
            div.innerHTML = `
                <div>
                    <div class="text-xs font-bold text-white">${req.driverName}</div>
                    <div class="text-[9px] text-gray-500 font-mono">BUS: ${req.busNumber} | PLATE: ${req.plateNumber}</div>
                    <div class="text-[9px] text-yellow-500 font-mono mt-1">REQ: ${routeData[req.routeId]?.name}</div>
                </div>
                <div class="flex gap-1">
                    <button onclick="rejectDriver('${docSnap.id}')" class="px-2 py-1 bg-red-900/30 text-red-400 border border-red-500/30 rounded text-[9px] hover:bg-red-500 hover:text-white transition"><i class="fa-solid fa-xmark"></i></button>
                    <button onclick="approveDriver('${docSnap.id}')" class="px-2 py-1 bg-green-900/30 text-green-400 border border-green-500/30 rounded text-[9px] hover:bg-green-500 hover:text-white transition"><i class="fa-solid fa-check"></i></button>
                </div>
            `;
            list.appendChild(div);
        });
    });
}

window.approveDriver = async (reqId) => {
    // 1. Get Request Data
    const reqRef = doc(db, 'artifacts', appId, 'public', 'data', 'shift_requests', reqId);
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) return;
    const req = reqSnap.data();

    // 2. Create Active Bus Doc
    const busData = {
        driverUser: req.driverUid,
        driverName: req.driverName,
        company: req.company,
        busNumber: req.busNumber,
        plateNumber: req.plateNumber,
        routeId: req.routeId,
        isReverse: false,
        lat: 0, lng: 0, speed: 0,
        startedAt: Date.now()
    };
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'active_buses', req.driverUid), busData);

    // 3. Delete Request
    await deleteDoc(reqRef);
};

window.rejectDriver = async (reqId) => {
    // Just delete request (or move to rejected collection, but delete is simpler for cleanup)
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'shift_requests', reqId));
};

function listenToFleet() {
    const q = query(
        collection(db, 'artifacts', appId, 'public', 'data', 'active_buses'),
        where('company', '==', currentUser.company)
    );
    
    onSnapshot(q, (snap) => {
        const list = document.getElementById('op-fleet-list');
        list.innerHTML = '';
        if(snap.empty) {
            list.innerHTML = '<div class="p-4 text-center text-gray-600 text-[10px] font-mono">FLEET IN GARRISON</div>';
            return;
        }

        snap.forEach(docSnap => {
            const bus = docSnap.data();
            const div = document.createElement('div');
            div.className = 'p-3 hover:bg-white/5 border-l-2 border-green-500';
            div.innerHTML = `
                <div class="flex justify-between">
                    <span class="text-xs font-bold text-white">${bus.driverName}</span>
                    <span class="text-xs font-mono text-green-400">${Math.round(bus.speed)} KM/H</span>
                </div>
                <div class="flex justify-between mt-1">
                    <span class="text-[9px] text-gray-500">BUS ${bus.busNumber} (${bus.plateNumber})</span>
                    <span class="text-[9px] text-gray-400">${routeData[bus.routeId]?.name.split('-')[1]}</span>
                </div>
            `;
            list.appendChild(div);
        });
    });
}

// --- PASSENGER / MAP LOGIC ---
function subscribeToBuses() {
    const busesRef = collection(db, 'artifacts', appId, 'public', 'data', 'active_buses');
    onSnapshot(busesRef, (snapshot) => {
        const buses = [];
        snapshot.forEach(doc => buses.push(doc.data()));
        activeBuses = buses;
        updateMap(buses);
        updatePassengerBoard(buses);
    });
}

function updateMap(buses) {
    // Remove old markers
    Object.keys(busMarkers).forEach(id => {
        if (!buses.find(b => b.driverUser === id)) {
            map.removeLayer(busMarkers[id]);
            delete busMarkers[id];
        }
    });

    buses.forEach(bus => {
        if (bus.lat === 0 && bus.lng === 0) return; // Skip if no GPS data yet

        const route = routeData[bus.routeId];
        const color = route?.color || '#fff';
        
        const html = `
            <div class="bus-icon-wrapper">
                <div class="bg-slate-900 rounded-full p-1 border-2 shadow-[0_0_10px_${color}]" style="border-color: ${color};">
                    <i class="fa-solid fa-bus text-[10px]" style="color: ${color};"></i>
                </div>
                <div class="absolute -bottom-4 left-1/2 -translate-x-1/2 bg-black/80 text-[8px] px-1 rounded text-white whitespace-nowrap border border-gray-700">
                    ${bus.busNumber}
                </div>
            </div>`;
            
        const icon = L.divIcon({ html: html, className: 'bg-transparent', iconSize: [30, 30] });

        if (!busMarkers[bus.driverUser]) {
            const marker = L.marker([bus.lat, bus.lng], { icon }).addTo(map);
            busMarkers[bus.driverUser] = marker;
        } else {
            const marker = busMarkers[bus.driverUser];
            marker.setLatLng([bus.lat, bus.lng]);
            marker.setIcon(icon);
        }
    });
}

function updatePassengerBoard(buses) {
    const board = document.getElementById('arrival-board');
    const searchVal = document.getElementById('passenger-search').value.toLowerCase();
    
    const filtered = buses.filter(b => 
        (b.driverName && b.driverName.toLowerCase().includes(searchVal)) || 
        (b.busNumber && b.busNumber.includes(searchVal)) ||
        (b.plateNumber && b.plateNumber.toLowerCase().includes(searchVal)) ||
        (routeData[b.routeId] && routeData[b.routeId].name.toLowerCase().includes(searchVal))
    );

    if (filtered.length === 0) {
        board.innerHTML = '<div class="text-center text-gray-500 py-10 text-[10px] font-mono tracking-widest">NO SIGNALS DETECTED IN SECTOR</div>';
        return;
    }

    board.innerHTML = filtered.map(b => {
        const route = routeData[b.routeId];
        const origin = route.name.split(' - ')[0];
        const dest = route.name.split(' - ')[1].split('(')[0];
        const routeText = b.isReverse ? `${dest} -> ${origin}` : `${origin} -> ${dest}`;
        
        return `
        <div class="flex justify-between items-center p-3 hover:bg-white/5 border-l-2 transition-all group cursor-default" style="border-color:${route?.color || '#fff'}">
            <div>
                <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-gray-200 tracking-wide">${b.busNumber}</span>
                    <span class="text-[9px] text-gray-500 font-mono bg-slate-800 px-1 rounded border border-gray-700">${b.plateNumber}</span>
                </div>
                <div class="text-[9px] text-cyan-400 font-mono mt-0.5">${routeText}</div>
                <div class="text-[9px] text-gray-500 font-mono">OP: ${b.driverName}</div>
            </div>
            <div class="text-right">
                <div class="font-mono font-bold text-sm ${b.speed > 60 ? 'text-red-500 animate-pulse' : 'text-green-400'}">${Math.round(b.speed)} <span class="text-[9px]">KM</span></div>
                <div class="text-[9px] text-gray-500">ETA: CALC...</div>
            </div>
        </div>
    `}).join('');
}

// --- EVENTS ---
function setupUIListeners() {
    // 1. Tab Switching Logic (Fix for "button can't clicked")
    const tabs = document.querySelectorAll('.tab-btn');
    const views = document.querySelectorAll('.view-section');

    tabs.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.currentTarget; // Ensures we get the button, not the icon
            const tabName = targetBtn.dataset.tab;

            // Update Tab Styling
            tabs.forEach(t => {
                t.classList.remove('active-tab');
                // Basic reset
                t.style.borderBottom = 'none';
                t.style.color = '#9ca3af'; // gray-400
                t.style.backgroundColor = 'transparent';
            });

            // Set Active Style
            targetBtn.classList.add('active-tab');
            // Inline style override for immediate feedback if CSS fails
            targetBtn.style.borderBottom = '2px solid #06b6d4';
            targetBtn.style.color = '#06b6d4';
            targetBtn.style.backgroundColor = 'rgba(6, 182, 212, 0.1)';

            // Switch Views
            views.forEach(v => v.classList.add('hidden'));
            const targetView = document.getElementById(`view-${tabName}`);
            if (targetView) {
                targetView.classList.remove('hidden');
            } else {
                console.warn(`View view-${tabName} not found`);
            }
        });
    });

    // Login Buttons
    const btnGoogleDr = document.getElementById('btn-google-driver');
    if(btnGoogleDr) btnGoogleDr.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('google', 'driver'); });

    const btnMsDr = document.getElementById('btn-ms-driver');
    if(btnMsDr) btnMsDr.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('microsoft', 'driver'); });

    const btnGoogleOp = document.getElementById('btn-google-op');
    if(btnGoogleOp) btnGoogleOp.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('google', 'operator'); });

    const btnMsOp = document.getElementById('btn-ms-op');
    if(btnMsOp) btnMsOp.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('microsoft', 'operator'); });

    // MFA & Shift
    const btnSendCode = document.getElementById('btn-send-code');
    if(btnSendCode) btnSendCode.addEventListener('click', initiateMFAEnrollment);

    const btnVerify = document.getElementById('btn-verify-code');
    if(btnVerify) btnVerify.addEventListener('click', () => {
        if (mfaResolver) verifyMFAChallenge();
        else verifyAndEnrollMFA();
    });

    const btnShift = document.getElementById('btn-shift');
    if(btnShift) btnShift.addEventListener('click', toggleShift);
    
    // Operator Logout
    window.opLogout = function() {
        auth.signOut().then(() => {
             document.getElementById('op-dashboard').classList.add('hidden');
             document.getElementById('op-auth').classList.remove('hidden');
        });
    }
}

// --- CORE MAP FUNCTIONS ---

function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: false }).setView([14.39, 120.90], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    
    // Render Routes
    Object.values(routeData).forEach(r => {
        L.polyline(r.path, { color: r.color, opacity: 0.3, weight: 2 }).addTo(map);
    });
}

// --- GPS & SIMULATION ---

async function toggleShift() {
    if (!currentUser || currentUser.role !== 'driver') return;

    const btn = document.getElementById('btn-shift');
    const routeId = document.getElementById('shift-route').value;
    const useRealGPS = document.getElementById('gps-toggle').checked;

    if (!isOnShift) {
        isOnShift = true;
        
        // Wake Lock
        try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e){}

        // UI Update
        btn.innerHTML = '<i class="fa-solid fa-power-off"></i> END SHIFT';
        btn.classList.remove('from-green-900/50', 'to-green-800/50', 'text-green-400');
        btn.classList.add('bg-red-900/20', 'text-red-400', 'border-red-500/50');
        document.getElementById('telemetry-panel').classList.remove('hidden');
        
        // Init Pos
        const routePoints = routeData[routeId].path;
        busState = { lat: routePoints[0][0], lng: routePoints[0][1], nextIndex: 1, speed: 0 };

        if (useRealGPS && navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => updateLocation(pos.coords.latitude, pos.coords.longitude, (pos.coords.speed||0)*3.6),
                (err) => startSimulation(routeId),
                { enableHighAccuracy: true }
            );
        } else {
            startSimulation(routeId);
        }
    } else {
        isOnShift = false;
        if (wakeLock) wakeLock.release();
        
        btn.innerHTML = 'INITIATE SHIFT';
        btn.classList.add('from-green-900/50', 'to-green-800/50', 'text-green-400');
        btn.classList.remove('bg-red-900/20', 'text-red-400', 'border-red-500/50');
        document.getElementById('telemetry-panel').classList.add('hidden');

        if (watchId) navigator.geolocation.clearWatch(watchId);
        if (simulationInterval) clearInterval(simulationInterval);
        
        deleteDoc(doc(db, 'active_buses', currentUser.uid));
    }
}

function startSimulation(routeId) {
    simulationInterval = setInterval(() => {
        const routePoints = routeData[routeId].path;
        const target = routePoints[busState.nextIndex];
        const current = [busState.lat, busState.lng];
        const dist = Math.sqrt(Math.pow(target[0] - current[0], 2) + Math.pow(target[1] - current[1], 2));
        
        let maxSpeed = 60;
        trafficZones.forEach(z => {
            if (Math.sqrt(Math.pow(z.lat - current[0], 2) + Math.pow(z.lng - current[1], 2)) < z.radius) maxSpeed = z.speedLimit;
        });

        let targetSpeed = maxSpeed;
        if(Math.random() > 0.8) targetSpeed += (Math.random()*20 - 10);
        busState.speed = busState.speed * 0.9 + targetSpeed * 0.1;

        const step = (busState.speed / 111 / 3600) * 5; 

        if (dist < step) {
            busState.lat = target[0]; busState.lng = target[1];
            busState.nextIndex = (busState.nextIndex + 1) % routePoints.length;
        } else {
            const r = step / dist;
            busState.lat += (target[0] - busState.lat) * r;
            busState.lng += (target[1] - busState.lng) * r;
        }

        updateLocation(busState.lat, busState.lng, busState.speed);
        
        // Update Telemetry UI
        document.getElementById('telemetry-speed').innerText = Math.round(busState.speed);
    }, 1000);
}

async function updateLocation(lat, lng, speed) {
    const routeId = document.getElementById('shift-route').value;
    const stops = routeData[routeId].stops;
    const nextStop = stops[Math.floor((busState.nextIndex / routeData[routeId].path.length) * stops.length)] || "Transit";
    document.getElementById('telemetry-next').innerText = nextStop;

    await setDoc(doc(db, 'active_buses', currentUser.uid), {
        driverUser: currentUser.uid, 
        driverName: currentUser.data.displayName || "Driver",
        routeId: routeId, lat, lng, speed, nextStop,
        timestamp: Date.now()
    });
}

// --- AUTH & DATA ---

async function checkUserProfile(user) {
    const userRef = doc(db, 'artifacts', 'default-app-id', 'public', 'data', 'users', user.uid);
    try {
        const snap = await getDoc(userRef);
        if (snap.exists()) loginUser(user, snap.data().role);
    } catch (e) {}
}

async function handleSocialLogin(providerName, role) {
    const provider = providerName === 'google' ? googleProvider : microsoftProvider;
    try {
        const result = await signInWithPopup(auth, provider);
        loginUser(result.user, role);
    } catch (error) {
        console.error(error);
        alert("Login Failed: " + error.message);
    }
}

async function loginUser(user, role) {
    const userRef = doc(db, 'artifacts', 'default-app-id', 'public', 'data', 'users', user.uid);
    await setDoc(userRef, {
        name: user.displayName || "Unknown",
        email: user.email,
        role: role,
        lastLogin: Date.now()
    }, { merge: true });

    if (role === 'driver') {
        document.getElementById('driver-auth').classList.add('hidden');
        document.getElementById('driver-dashboard').classList.remove('hidden');
        document.getElementById('driver-name-display').textContent = user.displayName;
    } else if (role === 'operator') {
        document.getElementById('op-auth').classList.add('hidden');
        document.getElementById('op-dashboard').classList.remove('hidden');
    }
    currentUser = { uid: user.uid, role: role, data: user };
}

// --- MAP & LIST UPDATES ---

function subscribeToBuses() {
    onSnapshot(collection(db, 'active_buses'), (snapshot) => {
        const buses = [];
        snapshot.forEach(doc => buses.push(doc.data()));
        updateMapMarkers(buses);
        updateUIBoard(buses);
        updateFleetList(buses);
    });
}

function updateMapMarkers(buses) {
    Object.keys(busMarkers).forEach(id => {
        if (!buses.find(b => b.driverUser === id)) {
            map.removeLayer(busMarkers[id]);
            delete busMarkers[id];
        }
    });

    buses.forEach(bus => {
        let marker = busMarkers[bus.driverUser];
        const color = routeData[bus.routeId]?.color || '#fff';
        
        const iconHtml = `
            <div class="bus-icon-wrapper ${bus.speed > 60 ? 'overspeeding-marker' : ''}">
                <div class="bg-[#0f172a] rounded-full p-1 border-2 shadow-[0_0_10px_${color}]" style="border-color: ${color};">
                    <i class="fa-solid fa-bus text-[10px]" style="color: ${color};"></i>
                </div>
            </div>`;
        const icon = L.divIcon({ html: iconHtml, className: 'bg-transparent', iconSize: [24, 24] });

        if (!marker) {
            marker = L.marker([bus.lat, bus.lng], { icon }).addTo(map);
            busMarkers[bus.driverUser] = marker;
        } else {
            marker.setLatLng([bus.lat, bus.lng]);
            marker.setIcon(icon);
        }
    });
}

function updateUIBoard(buses) {
    const board = document.getElementById('arrival-board');
    if (buses.length === 0) {
        board.innerHTML = '<div class="text-center text-gray-500 text-[10px] font-mono py-10">NO SIGNAL</div>';
        return;
    }
    board.innerHTML = buses.map(b => `
        <div class="flex justify-between p-3 bg-slate-800/50 rounded border-l-2 mb-2 transition-all hover:bg-slate-800" style="border-color:${routeData[b.routeId]?.color}">
            <div>
                <div class="text-xs font-bold text-gray-300 tracking-wide">${b.driverName}</div>
                <div class="text-[9px] text-gray-500 font-mono">${routeData[b.routeId]?.name.split('(')[0]}</div>
            </div>
            <div class="text-right">
                <div class="font-mono ${b.speed > 60 ? 'text-red-500 animate-pulse' : 'text-cyan-400'} font-bold text-xs">${Math.round(b.speed)} KM</div>
                <div class="text-[9px] text-gray-500">→ ${b.nextStop || '...'}</div>
            </div>
        </div>
    `).join('');
}

function updateFleetList(buses) {
    const list = document.getElementById('fleet-list');
    if(!list) return;
    if (buses.length === 0) {
        list.innerHTML = '<div class="p-4 text-center text-gray-600 text-[10px] font-mono">FLEET IN GARRISON</div>';
        return;
    }
    list.innerHTML = buses.map(b => `
        <div class="p-3 border-b border-gray-800 hover:bg-white/5 flex justify-between items-center">
            <div>
                <div class="text-[10px] font-bold text-white">${b.driverName}</div>
                <div class="text-[9px] text-gray-500">${routeData[b.routeId]?.name}</div>
            </div>
            <div class="text-[10px] font-mono text-green-400">ONLINE</div>
        </div>
    `).join('');
}

// MFA Placeholders
function setupRecaptcha() {}
function initiateMFAEnrollment() { alert("SMS Service Unavailable in Demo"); }
function verifyAndEnrollMFA() {}
function verifyMFAChallenge() {}

window.onload = init;