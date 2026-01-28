import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    getFirestore, 
    collection, 
    doc, 
    setDoc, 
    getDoc, 
    onSnapshot, 
    deleteDoc,
    updateDoc,
    query,
    where,
    serverTimestamp,
    addDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// --- CONFIGURATION ---
// IMPORTANT: Replace with your actual Firebase config keys
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'metro-cavite-v4'; // Namespace for data

// --- STATE ---
let map;
let routeData = {};
let busMarkers = {};
let activeBuses = [];
let currentUser = null;
let currentShift = null;
let watchId = null;
let wakeLock = null;

// --- INITIALIZATION ---
async function init() {
    try {
        const response = await fetch('./routes.json');
        const data = await response.json();
        routeData = data.routes;
        populateDropdowns(data.companies);
        initMap();
        setupAuthListener();
        setupFormListeners();
    } catch (e) {
        console.error("Init Error:", e);
    }
}

function initMap() {
    map = L.map('map', { 
        zoomControl: false, 
        attributionControl: false 
    }).setView([14.39, 120.90], 11);

    // FIXED: Correct Tile Layer URL
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
    }).addTo(map);

    // Draw Routes
    Object.values(routeData).forEach(r => {
        L.polyline(r.path, { 
            color: r.color, 
            opacity: 0.3, 
            weight: 3 
        }).addTo(map);
    });

    subscribeToBuses();
}

function populateDropdowns(companies) {
    const dSelect = document.getElementById('d-reg-company');
    const oSelect = document.getElementById('op-reg-company');
    
    companies.forEach(c => {
        dSelect.innerHTML += `<option value="${c}">${c}</option>`;
        oSelect.innerHTML += `<option value="${c}">${c}</option>`;
    });

    const routeSelect = document.getElementById('shift-route');
    Object.entries(routeData).forEach(([id, r]) => {
        routeSelect.innerHTML += `<option value="${id}">${r.name}</option>`;
    });
}

// --- AUTHENTICATION (USERNAME TRICK) ---
// We append @metrocavite.com to usernames to use Firebase Email Auth
const domain = "@metrocavite.com";

async function handleRegister(type) {
    const prefix = type === 'driver' ? 'd' : 'op';
    const username = document.getElementById(`${prefix}-reg-user`).value;
    const pass = document.getElementById(`${prefix}-reg-pass`).value;
    const company = document.getElementById(`${prefix}-reg-company`).value;
    const nameOrAddr = type === 'driver' ? document.getElementById('d-reg-name').value : document.getElementById('op-reg-address').value;
    
    if(!username || !pass || !company) return alert("All fields required");

    try {
        const email = username + domain;
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        
        const userData = {
            username: username,
            role: type,
            company: company,
            createdAt: serverTimestamp()
        };

        if (type === 'driver') {
            userData.name = nameOrAddr;
            userData.dob = document.getElementById('d-reg-dob').value;
            userData.status = 'pending'; // Requires approval
            
            // Store in 'drivers' collection but mark as pending
            await setDoc(doc(db, 'artifacts', appId, 'public', 'drivers', cred.user.uid), userData);
            alert("Registration successful! Please wait for Operator approval.");
        } else {
            userData.address = nameOrAddr; // Operator Address
            await setDoc(doc(db, 'artifacts', appId, 'public', 'operators', cred.user.uid), userData);
            alert("Operator Account Created.");
        }
    } catch (e) {
        alert("Error: " + e.message);
    }
}

async function handleLogin(type) {
    const prefix = type === 'driver' ? 'd' : 'op';
    const username = document.getElementById(`${prefix}-login-user`).value;
    const pass = document.getElementById(`${prefix}-login-pass`).value;
    
    try {
        await signInWithEmailAndPassword(auth, username + domain, pass);
    } catch (e) {
        alert("Login Failed: Check credentials");
    }
}

function setupAuthListener() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // Check Driver Profile
            let snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'drivers', user.uid));
            if (snap.exists()) {
                currentUser = { uid: user.uid, ...snap.data() };
                if (currentUser.status === 'pending') {
                    alert("Your account is still pending approval by " + currentUser.company);
                    signOut(auth);
                    return;
                }
                loadDriverDashboard();
                return;
            }

            // Check Operator Profile
            snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'operators', user.uid));
            if (snap.exists()) {
                currentUser = { uid: user.uid, ...snap.data() };
                loadOperatorDashboard();
                return;
            }
        } else {
            // Reset UI
            document.getElementById('driver-auth-container').classList.remove('hidden');
            document.getElementById('driver-dashboard').classList.add('hidden');
            document.getElementById('operator-auth-container').classList.remove('hidden');
            document.getElementById('operator-dashboard').classList.add('hidden');
        }
    });
}

// --- DRIVER DASHBOARD ---
function loadDriverDashboard() {
    document.getElementById('driver-auth-container').classList.add('hidden');
    document.getElementById('driver-dashboard').classList.remove('hidden');
    document.getElementById('dash-driver-name').innerText = currentUser.name;
    document.getElementById('dash-driver-company').innerText = currentUser.company;

    // Check if already on shift
    checkActiveShift();
}

async function toggleShift() {
    const btn = document.getElementById('btn-shift');
    
    if (!currentShift) {
        // START SHIFT
        const routeId = document.getElementById('shift-route').value;
        const status = document.getElementById('shift-status').value;
        
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');

        const shiftData = {
            driverId: currentUser.uid,
            driverName: currentUser.name,
            company: currentUser.company,
            routeId: routeId,
            status: status,
            speed: 0,
            lat: 0, 
            lng: 0,
            startTime: serverTimestamp()
        };

        // Create Active Bus Entry
        await setDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid), shiftData);
        
        // Log Start Time for Operator
        await addDoc(collection(db, 'artifacts', appId, 'public', 'shift_logs'), {
            ...shiftData,
            type: 'START'
        });

        currentShift = true;
        btn.innerHTML = 'END SHIFT';
        btn.classList.add('from-red-900', 'to-red-800', 'text-red-400');
        btn.classList.remove('from-green-900', 'to-green-800', 'text-green-400');
        document.getElementById('telemetry-panel').classList.remove('hidden');

        startGPS();

    } else {
        // END SHIFT
        if (watchId) navigator.geolocation.clearWatch(watchId);
        if (wakeLock) wakeLock.release();

        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid));
        
        // Log End Time
        await addDoc(collection(db, 'artifacts', appId, 'public', 'shift_logs'), {
            driverId: currentUser.uid,
            company: currentUser.company,
            endTime: serverTimestamp(),
            type: 'END'
        });

        currentShift = false;
        btn.innerHTML = 'START SHIFT';
        btn.classList.remove('from-red-900', 'to-red-800', 'text-red-400');
        btn.classList.add('from-green-900', 'to-green-800', 'text-green-400');
        document.getElementById('telemetry-panel').classList.add('hidden');
    }
}

function startGPS() {
    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(async (pos) => {
            const speed = (pos.coords.speed || 0) * 3.6; // m/s to km/h
            const status = document.getElementById('shift-status').value;
            
            document.getElementById('telemetry-speed').innerText = Math.round(speed) + " km/h";

            // Update Firestore
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid), {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                speed: speed,
                status: status,
                lastUpdate: serverTimestamp()
            });
        }, null, { enableHighAccuracy: true });
    }
}

// --- OPERATOR DASHBOARD ---
function loadOperatorDashboard() {
    document.getElementById('operator-auth-container').classList.add('hidden');
    document.getElementById('operator-dashboard').classList.remove('hidden');
    document.getElementById('dash-op-company').innerText = currentUser.company;

    // Listen for Requests
    const qRequests = query(collection(db, 'artifacts', appId, 'public', 'drivers'), 
        where('company', '==', currentUser.company), 
        where('status', '==', 'pending')
    );

    onSnapshot(qRequests, (snap) => {
        const list = document.getElementById('op-requests-list');
        document.getElementById('req-count').innerText = snap.size;
        list.innerHTML = '';
        
        if (snap.empty) list.innerHTML = '<div class="text-center text-gray-600 text-[10px] font-mono py-2">NO PENDING REQUESTS</div>';

        snap.forEach(docSnap => {
            const d = docSnap.data();
            list.innerHTML += `
                <div class="bg-slate-900 p-2 rounded flex justify-between items-center border border-gray-700">
                    <div>
                        <div class="text-xs font-bold text-white">${d.name}</div>
                        <div class="text-[9px] text-gray-500">User: ${d.username}</div>
                    </div>
                    <div class="flex gap-1">
                        <button onclick="approveDriver('${docSnap.id}')" class="px-2 py-1 bg-green-600 text-white text-[9px] rounded">ACCEPT</button>
                        <button onclick="rejectDriver('${docSnap.id}')" class="px-2 py-1 bg-red-600 text-white text-[9px] rounded">REJECT</button>
                    </div>
                </div>
            `;
        });
    });

    // Listen for Logs
    const qLogs = query(collection(db, 'artifacts', appId, 'public', 'shift_logs'), 
        where('company', '==', currentUser.company)
    ); // Add orderBy timestamp desc in real app (requires index)

    onSnapshot(qLogs, (snap) => {
        const list = document.getElementById('op-logs-list');
        list.innerHTML = '';
        snap.forEach(docSnap => {
            const l = docSnap.data();
            const time = l.startTime ? new Date(l.startTime.seconds * 1000).toLocaleTimeString() : new Date(l.endTime.seconds * 1000).toLocaleTimeString();
            const color = l.type === 'START' ? 'text-green-400' : 'text-red-400';
            list.innerHTML += `
                <div class="p-3 border-b border-gray-800 flex justify-between">
                    <div>
                        <div class="text-xs font-bold text-gray-300">${l.driverName || 'Driver'}</div>
                        <div class="text-[9px] text-gray-500 font-mono">${time}</div>
                    </div>
                    <div class="text-[10px] font-bold ${color}">${l.type} SHIFT</div>
                </div>
            `;
        });
    });
}

window.approveDriver = async (uid) => {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'drivers', uid), { status: 'approved' });
};

window.rejectDriver = async (uid) => {
    // In real app, maybe just change status to rejected or delete
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'drivers', uid));
};

// --- PASSENGER & MAP ---
function subscribeToBuses() {
    onSnapshot(collection(db, 'artifacts', appId, 'public', 'active_buses'), (snap) => {
        const buses = [];
        snap.forEach(d => buses.push(d.data()));
        updateMap(buses);
        updatePassengerList(buses);
    });
}

function updateMap(buses) {
    // Clear old markers
    Object.keys(busMarkers).forEach(k => {
        if(!buses.find(b => b.driverId === k)) {
            map.removeLayer(busMarkers[k]);
            delete busMarkers[k];
        }
    });

    buses.forEach(b => {
        if(b.lat === 0) return;

        // Determine Color based on Status
        let color = '#fff';
        if (b.status === 'arrived') color = '#22c55e'; // Green
        else if (b.status === 'arriving') color = '#facc15'; // Yellow
        else if (b.status === 'departing') color = '#f97316'; // Orange
        else if (b.status === 'departed') color = '#ef4444'; // Red

        // Flashing Red if Overspeeding
        const isFast = b.speed > 60;
        const className = `bus-icon-wrapper ${isFast ? 'overspeeding-marker' : ''}`;

        const icon = L.divIcon({
            className: 'bg-transparent',
            html: `
                <div class="${className}">
                    <div style="background-color: ${color}; box-shadow: 0 0 10px ${color};" class="w-4 h-4 rounded-full border-2 border-white"></div>
                </div>
            `,
            iconSize: [20, 20]
        });

        if (!busMarkers[b.driverId]) {
            const marker = L.marker([b.lat, b.lng], {icon}).addTo(map);
            marker.bindPopup(`
                <div class="font-mono text-xs">
                    <div class="font-bold text-white mb-1">${b.driverName}</div>
                    <div class="text-gray-400">${b.company}</div>
                    <div class="mt-1">Speed: ${Math.round(b.speed)} km/h</div>
                    <div style="color: ${color}" class="uppercase font-bold">${b.status}</div>
                </div>
            `);
            busMarkers[b.driverId] = marker;
        } else {
            const marker = busMarkers[b.driverId];
            marker.setLatLng([b.lat, b.lng]);
            marker.setIcon(icon);
        }
    });
}

function updatePassengerList(buses) {
    const list = document.getElementById('arrival-board');
    const search = document.getElementById('passenger-search').value.toLowerCase();
    
    const filtered = buses.filter(b => b.driverName.toLowerCase().includes(search) || b.company.toLowerCase().includes(search));

    if(filtered.length === 0) {
        list.innerHTML = '<div class="text-center text-gray-500 py-12 text-xs font-mono">NO BUSES ON SHIFT</div>';
        return;
    }

    list.innerHTML = filtered.map(b => {
        let statusColor = 'text-white';
        if(b.status === 'arriving') statusColor = 'text-yellow-400';
        if(b.status === 'arrived') statusColor = 'text-green-400';
        if(b.status === 'departing') statusColor = 'text-orange-400';
        if(b.status === 'departed') statusColor = 'text-red-400';

        return `
        <div class="p-3 border-b border-gray-800 hover:bg-white/5 cursor-pointer" onclick="focusBus('${b.driverId}')">
            <div class="flex justify-between items-center">
                <div>
                    <div class="text-xs font-bold text-white">${b.driverName}</div>
                    <div class="text-[9px] text-gray-500 uppercase">${b.company}</div>
                </div>
                <div class="text-right">
                    <div class="text-xs font-mono font-bold ${b.speed > 60 ? 'text-red-500 animate-pulse' : 'text-cyan-400'}">${Math.round(b.speed)} km/h</div>
                    <div class="text-[9px] font-bold uppercase ${statusColor}">${b.status}</div>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

window.focusBus = (id) => {
    const marker = busMarkers[id];
    if(marker) {
        map.setView(marker.getLatLng(), 15);
        marker.openPopup();
    }
}

// --- SETUP LISTENERS ---
function setupFormListeners() {
    document.getElementById('driver-signup-form').addEventListener('submit', (e) => { e.preventDefault(); handleRegister('driver'); });
    document.getElementById('driver-login-form').addEventListener('submit', (e) => { e.preventDefault(); handleLogin('driver'); });
    document.getElementById('op-signup-form').addEventListener('submit', (e) => { e.preventDefault(); handleRegister('operator'); });
    document.getElementById('op-login-form').addEventListener('submit', (e) => { e.preventDefault(); handleLogin('operator'); });
    
    document.getElementById('btn-shift').addEventListener('click', toggleShift);
    document.getElementById('passenger-search').addEventListener('input', () => {
        // Trigger re-render of list
        getDoc(doc(db, 'dummy')).then(() => {}); // Hack to trigger refresh or store buses locally to filter
    });
}

// Helpers
window.logout = () => signOut(auth);
async function checkActiveShift() {
    const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid));
    if(snap.exists()) {
        currentShift = true;
        const btn = document.getElementById('btn-shift');
        btn.innerHTML = 'END SHIFT';
        btn.classList.add('from-red-900', 'to-red-800', 'text-red-400');
        btn.classList.remove('from-green-900', 'to-green-800', 'text-green-400');
        document.getElementById('telemetry-panel').classList.remove('hidden');
        startGPS();
    }
}

window.onload = init;