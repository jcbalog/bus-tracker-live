import { auth, db } from './firebase-config.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";

const appId = 'metro-cavite-v4';
const domain = "@metrocavite.com";

let currentUser = null;
let currentShift = false;
let watchId = null;

async function init() {
    const response = await fetch('./routes.json');
    const data = await response.json();
    populateDropdowns(data.companies, data.routes);
    
    onAuthStateChanged(auth, user => {
        if (user) checkProfile(user);
        else showAuth();
    });

    setupListeners();
}

function populateDropdowns(companies, routes) {
    const compSelect = document.getElementById('reg-company');
    const routeSelect = document.getElementById('shift-route');
    
    companies.forEach(c => compSelect.innerHTML += `<option value="${c}">${c}</option>`);
    Object.entries(routes).forEach(([id, r]) => routeSelect.innerHTML += `<option value="${id}">${r.name}</option>`);
}

function setupListeners() {
    document.getElementById('tab-login').addEventListener('click', () => {
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('signup-form').classList.add('hidden');
        document.getElementById('tab-login').classList.add('bg-green-900', 'text-white');
        document.getElementById('tab-signup').classList.remove('bg-green-900', 'text-white');
    });
    
    document.getElementById('tab-signup').addEventListener('click', () => {
        document.getElementById('login-form').classList.add('hidden');
        document.getElementById('signup-form').classList.remove('hidden');
        document.getElementById('tab-signup').classList.add('bg-green-900', 'text-white');
        document.getElementById('tab-login').classList.remove('bg-green-900', 'text-white');
    });

    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('signup-form').addEventListener('submit', handleSignup);
    document.getElementById('btn-logout').addEventListener('click', () => signOut(auth));
    document.getElementById('btn-shift').addEventListener('click', toggleShift);
}

async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    try {
        await signInWithEmailAndPassword(auth, user + domain, pass);
    } catch (err) {
        alert("Login Failed: " + err.message);
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const user = document.getElementById('reg-user').value;
    const pass = document.getElementById('reg-pass').value;
    const name = document.getElementById('reg-name').value;
    const company = document.getElementById('reg-company').value;
    
    try {
        const cred = await createUserWithEmailAndPassword(auth, user + domain, pass);
        await setDoc(doc(db, 'artifacts', appId, 'public', 'drivers', cred.user.uid), {
            username: user,
            name: name,
            company: company,
            role: 'driver',
            status: 'pending',
            createdAt: serverTimestamp()
        });
        alert("Registered! Wait for operator approval.");
    } catch (err) {
        alert("Signup Failed: " + err.message);
    }
}

async function checkProfile(user) {
    const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'drivers', user.uid));
    if (snap.exists()) {
        const data = snap.data();
        if (data.status === 'pending') {
            alert("Account pending approval.");
            signOut(auth);
            return;
        }
        currentUser = { uid: user.uid, ...data };
        showDashboard();
    } else {
        alert("No driver profile found.");
        signOut(auth);
    }
}

function showAuth() {
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('dashboard-section').classList.add('hidden');
}

function showDashboard() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('dashboard-section').classList.remove('hidden');
    document.getElementById('driver-name').innerText = currentUser.name;
    document.getElementById('driver-company').innerText = currentUser.company;
    
    getDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid)).then(snap => {
        if(snap.exists()) {
            currentShift = true;
            updateShiftUI();
            startGPS();
        }
    });
}

async function toggleShift() {
    if (!currentShift) {
        const route = document.getElementById('shift-route').value;
        await setDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid), {
            driverId: currentUser.uid,
            driverName: currentUser.name,
            company: currentUser.company,
            routeId: route,
            speed: 0,
            lat: 0, lng: 0,
            status: 'departing',
            startTime: serverTimestamp()
        });
        
        await addDoc(collection(db, 'artifacts', appId, 'public', 'shift_logs'), {
            type: 'START', driverName: currentUser.name, company: currentUser.company, time: serverTimestamp()
        });

        currentShift = true;
        startGPS();
    } else {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid));
        
        await addDoc(collection(db, 'artifacts', appId, 'public', 'shift_logs'), {
            type: 'END', driverName: currentUser.name, company: currentUser.company, time: serverTimestamp()
        });

        currentShift = false;
        if(watchId) navigator.geolocation.clearWatch(watchId);
    }
    updateShiftUI();
}

function updateShiftUI() {
    const btn = document.getElementById('btn-shift');
    if (currentShift) {
        btn.innerText = "END SHIFT";
        btn.classList.replace('from-green-900', 'from-red-900');
        btn.classList.replace('to-green-700', 'to-red-700');
        document.getElementById('gps-status').innerHTML = 'GPS STATUS: <span class="text-green-500 animate-pulse">LIVE TRACKING</span>';
    } else {
        btn.innerText = "START SHIFT";
        btn.classList.replace('from-red-900', 'from-green-900');
        btn.classList.replace('to-red-700', 'to-green-700');
        document.getElementById('gps-status').innerHTML = 'GPS STATUS: <span class="text-red-500">OFFLINE</span>';
    }
}

function startGPS() {
    if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(async (pos) => {
            const speed = (pos.coords.speed || 0) * 3.6;
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'active_buses', currentUser.uid), {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                speed: speed
            });
        }, null, { enableHighAccuracy: true });
    }
}

window.onload = init;