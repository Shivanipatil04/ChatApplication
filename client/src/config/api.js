import axios from "axios";

const getDefaultApiUrl = () => {
  return "http://localhost:5000";
};

export const API_URL = (
  import.meta.env.VITE_API_URL || getDefaultApiUrl()
).replace(/\/+$/, "");

export const api = axios.create({
  baseURL: API_URL,
});