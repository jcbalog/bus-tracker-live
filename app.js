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

// IMPORT LEAFLET (Critical Fix)
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

let map, trafficLayerGroup;
let routeData = {}; 
let busMarkers = {};
let watchId = null; 
let simulationInterval = null;
let currentUser = null; 
let verificationId = null;
let mfaResolver = null; 
let isOnShift = false;
let busState = { nextIndex: 1, progress: 0, speed: 0, lat: 0, lng: 0, pax: 0 };
let wakeLock = null; // Wake Lock Variable

// Traffic Zones for Simulation logic
const trafficZones = [
    { lat: 14.4630, lng: 120.9730, radius: 0.015, speedLimit: 15 }, // Talaba
    { lat: 14.4050, lng: 120.8750, radius: 0.010, speedLimit: 20 }, // Tejero
    { lat: 14.3250, lng: 120.9380, radius: 0.015, speedLimit: 25 }  // SM Dasma
];

async function init() {
    try {
        const response = await fetch('./routes.json');
        const data = await response.json();
        routeData = data.routes;

        initMap();
        
        auth.onAuthStateChanged((user) => {
            if (!user) {
                signInAnonymously(auth).catch(e => console.error("Auth Error", e));
            } else {
                // Check if user has a profile to determine role
                checkUserProfile(user);
            }
        });

        subscribeToBuses();
        setupUIListeners();
        setupRecaptcha();
    } catch (error) {
        console.error("Initialization Failed:", error);
    }
}

async function checkUserProfile(user) {
    // Quick check to restore session state if page refreshed
    const userRef = doc(db, 'artifacts', 'default-app-id', 'public', 'data', 'users', user.uid);
    try {
        const snap = await getDoc(userRef);
        if (snap.exists()) {
            const data = snap.data();
            loginUser(user, data.role);
        }
    } catch (e) {
        console.log("Anonymous or new user");
    }
}

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([14.39, 120.90], 11);
    
    // Dark Mode Tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        maxZoom: 19,
        subdomains: 'abcd'
    }).addTo(map);
    
    // Fix: Ensure routeData exists before iterating
    if (routeData) {
        Object.values(routeData).forEach(r => {
            L.polyline(r.path, { color: r.color, opacity: 0.3 }).addTo(map);
        });
    }
}

// --- GPS TRACKING ENGINE ---

async function toggleShift() {
    if (!currentUser || currentUser.role !== 'driver') return;

    const btn = document.getElementById('btn-shift');
    const routeId = document.getElementById('shift-route').value;
    const useRealGPS = document.getElementById('gps-toggle').checked;

    if (!isOnShift) {
        // START SHIFT
        isOnShift = true;
        
        // 1. ACTIVATE WAKE LOCK (Keeps screen on for GPS accuracy)
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Screen Wake Lock active');
            }
        } catch (err) {
            console.error(`Wake Lock Error: ${err.name}, ${err.message}`);
        }

        btn.innerHTML = '<i class="fa-solid fa-power-off"></i> END SHIFT';
        btn.classList.remove('bg-green-600/20', 'text-green-400', 'border-green-500/50');
        btn.classList.add('bg-red-600/20', 'text-red-400', 'border-red-500/50');
        
        // Init Start Position
        const routePoints = routeData[routeId].path;
        busState = {
            lat: routePoints[0][0],
            lng: routePoints[0][1],
            nextIndex: 1,
            speed: 0,
            pax: Math.floor(Math.random() * 30)
        };

        if (useRealGPS && navigator.geolocation) {
            // REAL GPS MODE (High Accuracy)
            watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const speedKmh = (pos.coords.speed || 0) * 3.6; 
                    if (pos.coords.accuracy < 50) {
                        updateLocation(pos.coords.latitude, pos.coords.longitude, speedKmh);
                    }
                },
                (err) => {
                    console.error("GPS Error:", err);
                    alert("GPS Signal Lost. Switching to Simulation.");
                    startSimulation(routeId); // Fallback
                },
                { 
                    enableHighAccuracy: true, 
                    maximumAge: 0, 
                    timeout: 10000 
                }
            );
        } else {
            // SIMULATION MODE
            startSimulation(routeId);
        }

    } else {
        // END SHIFT
        isOnShift = false;
        
        // 2. RELEASE WAKE LOCK
        if (wakeLock !== null) {
            wakeLock.release().then(() => { wakeLock = null; });
        }

        btn.innerHTML = 'START SHIFT';
        btn.classList.add('bg-green-600/20', 'text-green-400', 'border-green-500/50');
        btn.classList.remove('bg-red-600/20', 'text-red-400', 'border-red-500/50');

        if (watchId) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        if (simulationInterval) {
            clearInterval(simulationInterval);
            simulationInterval = null;
        }
        
        // Remove bus from active map
        deleteDoc(doc(db, 'active_buses', currentUser.uid));
    }
}

function startSimulation(routeId) {
    simulationInterval = setInterval(() => {
        const routePoints = routeData[routeId].path;
        const target = routePoints[busState.nextIndex];
        const current = [busState.lat, busState.lng];
        const dist = Math.sqrt(Math.pow(target[0] - current[0], 2) + Math.pow(target[1] - current[1], 2));
        
        // Calculate dynamic speed based on Traffic Zones
        let maxSpeed = 70;
        trafficZones.forEach(zone => {
            const distToZone = Math.sqrt(Math.pow(zone.lat - current[0], 2) + Math.pow(zone.lng - current[1], 2));
            if (distToZone < zone.radius) maxSpeed = zone.speedLimit;
        });

        // Add some random variance to speed
        let targetSpeed = maxSpeed;
        if (Math.random() > 0.8) targetSpeed += (Math.random() * 20 - 10);
        
        // Smooth acceleration
        busState.speed = busState.speed * 0.8 + targetSpeed * 0.2; 
        
        // Move Logic
        const speedDegSec = (busState.speed / 111) / 3600; 
        const step = speedDegSec * 5; // 5x time scale for demo purposes

        if (dist < step) {
            busState.lat = target[0];
            busState.lng = target[1];
            busState.nextIndex++;
            if (busState.nextIndex >= routePoints.length) {
                busState.nextIndex = 0; // Loop route
                busState.lat = routePoints[0][0];
                busState.lng = routePoints[0][1];
            }
        } else {
            const ratio = step / dist;
            busState.lat += (target[0] - busState.lat) * ratio;
            busState.lng += (target[1] - busState.lng) * ratio;
        }

        updateLocation(busState.lat, busState.lng, busState.speed);
    }, 1000);
}

async function updateLocation(lat, lng, speed) {
    const routeId = document.getElementById('shift-route').value;
    
    const stops = routeData[routeId].stops;
    const pathLen = routeData[routeId].path.length;
    const nextStop = isOnShift && simulationInterval ? 
        (stops[Math.floor((busState.nextIndex / pathLen) * stops.length)] || "Base") : "In Transit";

    await setDoc(doc(db, 'active_buses', currentUser.uid), {
        driverUser: currentUser.uid, 
        driverName: currentUser.data.displayName || currentUser.data.name || "Driver",
        company: "Metro Cavite", 
        routeId: routeId,
        lat: lat,
        lng: lng,
        speed: speed,
        pax: busState.pax,
        nextStop: nextStop,
        timestamp: Date.now()
    });
}

// --- MFA & AUTH LOGIC ---

function setupRecaptcha() {
    if(!document.getElementById('recaptcha-container')) return;
    window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        'size': 'invisible'
    });
}

async function handleSocialLogin(providerName, role) {
    const provider = providerName === 'google' ? googleProvider : microsoftProvider;
    try {
        const result = await signInWithPopup(auth, provider);
        checkMFAEnrollment(result.user, role);
    } catch (error) {
        if (error.code === 'auth/multi-factor-auth-required') {
            mfaResolver = error.resolver;
            initiateMFAChallenge(mfaResolver.hints[0]); 
        } else {
            alert("Login Failed: " + error.message);
        }
    }
}

async function checkMFAEnrollment(user, role) {
    // Basic check - in production you would check enrolledFactors
    // For this demo, we assume first login needs enrollment if forced
    loginUser(user, role);
}

async function initiateMFAEnrollment() {
    const phoneNumber = document.getElementById('mfa-phone').value;
    if (!phoneNumber) return alert("Enter phone number");
    const phoneAuthProvider = new PhoneAuthProvider(auth);
    try {
        verificationId = await phoneAuthProvider.verifyPhoneNumber(phoneNumber, window.recaptchaVerifier);
        document.getElementById('mfa-step-1').classList.add('hidden');
        document.getElementById('mfa-step-2').classList.remove('hidden');
    } catch (e) {
        alert("SMS Send Failed: " + e.message);
    }
}

async function verifyAndEnrollMFA() {
    const code = document.getElementById('mfa-code').value;
    const cred = PhoneAuthProvider.credential(verificationId, code);
    const multiFactorAssertion = PhoneMultiFactorGenerator.assertion(cred);
    try {
        await multiFactor(currentUser.user).enroll(multiFactorAssertion, "Phone Number");
        document.getElementById('mfa-modal').classList.add('hidden');
        loginUser(currentUser.user, currentUser.role);
    } catch (e) {
        alert("Verification Failed: " + e.message);
    }
}

async function initiateMFAChallenge(hint) {
    document.getElementById('mfa-modal').classList.remove('hidden');
    document.getElementById('mfa-step-1').classList.add('hidden'); 
    document.getElementById('mfa-step-2').classList.remove('hidden');
    document.getElementById('mfa-title').innerText = "Security Check";
    document.getElementById('mfa-msg').innerText = "Enter code sent to ... " + hint.phoneNumber.slice(-4);
    
    const phoneAuthProvider = new PhoneAuthProvider(auth);
    try {
        verificationId = await phoneAuthProvider.verifyPhoneNumber(
            { multiFactorHint: hint, session: mfaResolver.session },
            window.recaptchaVerifier
        );
    } catch (e) {
        alert("Could not send code: " + e.message);
    }
}

async function verifyMFAChallenge() {
    const code = document.getElementById('mfa-code').value;
    const cred = PhoneAuthProvider.credential(verificationId, code);
    const multiFactorAssertion = PhoneMultiFactorGenerator.assertion(cred);
    try {
        const result = await mfaResolver.resolveSignIn(multiFactorAssertion);
        document.getElementById('mfa-modal').classList.add('hidden');
        // Fetch role from DB
        const userRef = doc(db, 'artifacts', 'default-app-id', 'public', 'data', 'users', result.user.uid);
        const snap = await getDoc(userRef);
        const role = snap.exists() ? snap.data().role : 'driver'; // fallback
        loginUser(result.user, role); 
    } catch (e) {
        alert("Invalid Code");
    }
}

async function loginUser(user, role) {
    // Save/Update user profile
    const userRef = doc(db, 'artifacts', 'default-app-id', 'public', 'data', 'users', user.uid);
    await setDoc(userRef, {
        name: user.displayName || "Unknown",
        email: user.email,
        role: role,
        lastLogin: Date.now()
    }, { merge: true });

    // Update UI based on Role
    if (role === 'driver') {
        document.getElementById('driver-auth').classList.add('hidden');
        document.getElementById('driver-dashboard').classList.remove('hidden');
        document.getElementById('driver-name-display').textContent = user.displayName;
    } else if (role === 'operator') {
        document.getElementById('operator-auth').classList.add('hidden');
        document.getElementById('operator-dashboard').classList.remove('hidden');
    }
    
    currentUser = { uid: user.uid, role: role, data: user };
}

// --- UI LISTENERS ---
function setupUIListeners() {
    // Login Buttons
    const btnGoogleDriver = document.getElementById('btn-google-driver');
    if(btnGoogleDriver) btnGoogleDriver.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('google', 'driver'); });
    
    const btnMsDriver = document.getElementById('btn-ms-driver');
    if(btnMsDriver) btnMsDriver.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('microsoft', 'driver'); });
    
    const btnGoogleOp = document.getElementById('btn-google-op');
    if(btnGoogleOp) btnGoogleOp.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('google', 'operator'); });
    
    const btnMsOp = document.getElementById('btn-ms-op');
    if(btnMsOp) btnMsOp.addEventListener('click', (e) => { e.preventDefault(); handleSocialLogin('microsoft', 'operator'); });

    // MFA
    const btnSendCode = document.getElementById('btn-send-code');
    if(btnSendCode) btnSendCode.addEventListener('click', initiateMFAEnrollment);
    
    const btnVerifyCode = document.getElementById('btn-verify-code');
    if(btnVerifyCode) btnVerifyCode.addEventListener('click', () => {
        if (mfaResolver) verifyMFAChallenge();
        else verifyAndEnrollMFA();
    });

    // Shift Toggle
    const btnShift = document.getElementById('btn-shift');
    if(btnShift) btnShift.addEventListener('click', toggleShift);

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active classes
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active-tab'));
            e.currentTarget.classList.add('active-tab');

            // Switch Views
            document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
            document.getElementById(`view-${e.currentTarget.dataset.tab}`).classList.remove('hidden');
        });
    });
}

// --- REAL-TIME MAP UPDATES ---
function subscribeToBuses() {
    onSnapshot(collection(db, 'active_buses'), (snapshot) => {
        const buses = [];
        snapshot.forEach(doc => buses.push(doc.data()));
        updateMapMarkers(buses);
        updateUIBoard(buses);
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
        const isOverspeeding = bus.speed > 60;
        
        const iconHtml = `
            <div class="bus-icon-wrapper ${isOverspeeding ? 'overspeeding-marker' : ''}">
                <div class="bg-[#0f172a] rounded-full p-1.5 border-2 shadow-[0_0_15px_${color}]" style="border-color: ${color};">
                        <i class="fa-solid fa-location-arrow text-[10px]" style="color: ${color}; transform: rotate(-45deg);"></i>
                </div>
            </div>`;
            
        const icon = L.divIcon({ html: iconHtml, className: 'bg-transparent', iconSize: [30, 30], iconAnchor: [15, 15] });

        if (!marker) {
            marker = L.marker([bus.lat, bus.lng], { icon }).addTo(map);
            marker.bindPopup(`
                <div class="p-2 bg-slate-900 text-white border border-gray-700 rounded font-mono text-xs">
                    <div style="color:${color}" class="font-bold mb-1">${bus.driverName}</div>
                    <div>SPEED: ${Math.round(bus.speed)} KM/H</div>
                    <div>NEXT: ${bus.nextStop}</div>
                </div>
            `);
            busMarkers[bus.driverUser] = marker;
        } else {
            marker.setLatLng([bus.lat, bus.lng]);
            marker.setIcon(icon);
            marker.setPopupContent(`
                <div class="p-2 bg-slate-900 text-white border border-gray-700 rounded font-mono text-xs">
                    <div style="color:${color}" class="font-bold mb-1">${bus.driverName}</div>
                    <div>SPEED: ${Math.round(bus.speed)} KM/H</div>
                    <div>NEXT: ${bus.nextStop}</div>
                </div>
            `);
        }
    });
}

function updateUIBoard(buses) {
    const board = document.getElementById('arrival-board');
    if (buses.length === 0) {
        board.innerHTML = '<div class="text-center text-gray-500 text-xs font-mono py-10">NO ACTIVE UNITS</div>';
        return;
    }
    board.innerHTML = buses.map(b => `
        <div class="flex justify-between p-3 bg-slate-800/50 rounded border-l-2 mb-2 transition-all hover:bg-slate-800" style="border-color:${routeData[b.routeId]?.color}">
            <div>
                <div class="text-xs font-bold text-gray-300 tracking-wide">${b.driverName}</div>
                <div class="text-[10px] text-gray-500 font-mono">${routeData[b.routeId]?.name.split('(')[0]}</div>
            </div>
            <div class="text-right">
                <div class="font-mono ${b.speed > 60 ? 'text-red-500 animate-pulse' : 'text-cyan-400'} font-bold">${Math.round(b.speed)} <span class="text-[9px]">KM/H</span></div>
                <div class="text-[9px] text-gray-500">→ ${b.nextStop || '...'}</div>
            </div>
        </div>
    `).join('');
}

window.onload = init;