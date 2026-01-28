import { initializeApp } from "firebase/app";
import { 
    getAuth, 
    signInAnonymously, 
    GoogleAuthProvider, 
    OAuthProvider, 
    signInWithPopup,
    PhoneAuthProvider,
    PhoneMultiFactorGenerator,
    RecaptchaVerifier,
    multiFactor
} from "firebase/auth";
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, deleteDoc } from "firebase/firestore";

// Replace with your OWN Firebase project config from console.firebase.google.com
const firebaseConfig = {
  apiKey: "AIzaSyAId2dJ-z7Vk5VNugjsLCRDiHzeMxPn9_M",
  authDomain: "cavite-live-track.firebaseapp.com",
  databaseURL: "https://cavite-live-track-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "cavite-live-track",
  storageBucket: "cavite-live-track.firebasestorage.app",
  messagingSenderId: "195142604130",
  appId: "1:195142604130:web:82479738eed78aaf01c83b",
  measurementId: "G-XL267WFSFF"
};

// Initialize App
export const app = initializeApp(firebaseConfig);

// Initialize Services & Export Directly (Fixes build error)
export const auth = getAuth(app);
export const db = getFirestore(app);

// Auth Providers
export const googleProvider = new GoogleAuthProvider();
export const microsoftProvider = new OAuthProvider('microsoft.com');

// Re-export modular functions for usage in app.js
export { 
    signInAnonymously, 
    signInWithPopup, 
    PhoneAuthProvider,
    PhoneMultiFactorGenerator,
    RecaptchaVerifier,
    multiFactor,
    collection, doc, setDoc, getDoc, onSnapshot, deleteDoc 
};