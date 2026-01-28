// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);