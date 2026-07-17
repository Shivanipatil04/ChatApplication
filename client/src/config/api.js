import axios from 'axios'

// const DEFAULT_BACKEND_PORT = '5000'

const getDefaultApiUrl = () => {
  if (typeof window === 'undefined') {
    return `http://localhost:${DEFAULT_BACKEND_PORT}`
  }

  const { hostname } = window.location
  return `http://${hostname}:${DEFAULT_BACKEND_PORT}`
}

// export const API_URL = (import.meta.env.VITE_API_URL || getDefaultApiUrl()).replace(/\/+$/, '')




export const API_URL = (import.meta.env.VITE_API_URL )

export const api = axios.create({
  baseURL: API_URL,
})
