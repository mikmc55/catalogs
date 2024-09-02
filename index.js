const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const schedule = require('node-schedule');
require('dotenv').config(); // Load environment variables

// Logger configuration
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'addon.log' })
    ]
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = process.env.TMDB_BASE_URL;
const CACHE_DIR = path.join(__dirname, process.env.CACHE_DIR);
const CATALOG_CACHE_FILE = path.join(CACHE_DIR, 'catalog_cache.json');
const META_CACHE_FILE = path.join(CACHE_DIR, 'meta_cache.json');

const START_YEAR = process.env.START_YEAR || 2015;
const END_YEAR = process.env.END_YEAR || 2024;
const MIN_SCORE = process.env.MIN_SCORE || 4;
const NUM_PAGES = process.env.NUM_PAGES || 5;
const EXCLUDED_GENRES = process.env.EXCLUDED_GENRES || '16,10402';
const INCLUDED_GENRES = process.env.INCLUDED_GENRES || '28,12,35,14'; // Single genres
const INCLUDED_GENRES_OR = process.env.INCLUDED_GENRES_OR || '28|12|35|14'; // OR combinations
const LANGUAGE = process.env.LANGUAGE || 'en';

// Genre Combinations for querying
const GENRE_COMBINATIONS = [
    '28,12', // Action, Adventure
    '28,35', // Action, Comedy
    '28,14', // Action, Fantasy
    '14,12', // Fantasy, Adventure
    '14,35'  // Fantasy, Comedy
];

let catalogCache = {};
let metaCache = {};

const manifest = {
    id: 'org.stremio.action-addon',
    version: '1.0.0',
    name: 'Action Varied',
    description: 'Stremio Add-on to showcase movies with configurable filters',
    catalogs: [
        {
            type: 'Easynews',
            id: 'action-movies-catalog',
            name: 'Action Varied',
            extra: [{ name: 'search', isRequired: false }]
        }
    ],
    resources: ['catalog', 'meta'],
    types: ['movie'],
    idPrefixes: ['tmdb']
};

const builder = new addonBuilder(manifest);

async function ensureCacheDirectory() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        logger.debug('Cache directory ensured');
    } catch (error) {
        logger.error('Error creating cache directory:', error);
    }
}

async function loadCache() {
    try {
        const catalogData = await fs.readFile(CATALOG_CACHE_FILE, 'utf8');
        catalogCache = JSON.parse(catalogData);
        logger.debug(`Catalog cache loaded. Items: ${catalogCache.data ? catalogCache.data.length : 0}`);
    } catch (error) {
        logger.info('No existing catalog cache found. Will create a new one.');
    }

    try {
        const metaData = await fs.readFile(META_CACHE_FILE, 'utf8');
        metaCache = JSON.parse(metaData);
        logger.debug(`Meta cache loaded. Items: ${Object.keys(metaCache).length}`);
    } catch (error) {
        logger.info('No existing meta cache found. Will create a new one.');
    }
}

async function saveCache() {
    try {
        await fs.writeFile(CATALOG_CACHE_FILE, JSON.stringify(catalogCache));
        await fs.writeFile(META_CACHE_FILE, JSON.stringify(metaCache));
        logger.debug('Cache saved successfully');
    } catch (error) {
        logger.error('Error saving cache:', error);
    }
}

async function fetchMoviesForCombination(genreCombination) {
    let page = 1;
    let totalPages = 1;
    const allResults = [];

    try {
        do {
            const url = `${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&include_adult=false&include_video=false&language=${LANGUAGE}&page=${page}&sort_by=primary_release_date.desc&primary_release_date.gte=${START_YEAR}-01-01&primary_release_date.lte=${END_YEAR}-12-31&vote_average.gte=${MIN_SCORE}&with_genres=${genreCombination}&with_original_language=${LANGUAGE}&without_genres=${EXCLUDED_GENRES}`;
            logger.debug(`Requesting TMDB: ${url}`);

            const response = await axios.get(url);
            const { results, total_pages } = response.data;
            totalPages = total_pages;

            logger.debug(`Page ${page}/${totalPages} fetched for genre combination ${genreCombination}. Results: ${results.length}`);

            const validResults = results.filter(movie => movie.release_date && !isNaN(new Date(movie.release_date)));
            allResults.push(...validResults);

            page++;
        } while (page <= NUM_PAGES && page <= totalPages);

        return allResults;
    } catch (error) {
        logger.error(`Error fetching movies for genre combination ${genreCombination}:`, error);
        return [];
    }
}

async function fetchMovies() {
    const allResults = [];

    for (const combination of GENRE_COMBINATIONS) {
        const results = await fetchMoviesForCombination(combination);
        allResults.push(...results);
    }

    allResults.sort((a, b) => new Date(b.release_date) - new Date(a.release_date));
    logger.info(`Total movies fetched: ${allResults.length}`);
    return allResults;
}

async function fetchMovieMetadata(movieId) {
    try {
        const url = `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}`;
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        logger.error(`Error fetching metadata for movie ID ${movieId}:`, error.message);
        return { error: 'Failed to fetch movie data' };
    }
}

async function updateCatalogAndMetaCache() {
    logger.info('Updating catalog and meta cache...');
    try {
        const results = await fetchMovies();
        catalogCache = {
            timestamp: Date.now(),
            data: results
        };

        for (const movie of results) {
            const movieId = movie.id;
            logger.debug(`Fetching meta for movie ID: ${movieId}`);
            const movieData = await fetchMovieMetadata(movieId);
            metaCache[movieId] = {
                timestamp: Date.now(),
                data: movieData
            };
        }

        await saveCache();
        logger.info(`Catalog and meta cache updated. Items: ${results.length}`);
    } catch (error) {
        logger.error('Error updating catalog and meta cache:', error);
    }
}

builder.defineCatalogHandler(async (args) => {
    const searchQuery = args.extra && args.extra.search ? args.extra.search : '';
    logger.debug(`Catalog request received. Query: "${searchQuery}"`);

    let results = catalogCache.data || [];
    logger.debug(`Catalog cache has ${results.length} items`);

    if (searchQuery) {
        results = results.filter(movie => 
            movie.title.toLowerCase().includes(searchQuery.toLowerCase())
        );
        logger.debug(`Filtered results for "${searchQuery}": ${results.length}`);
    }

    const metas = results.map(item => ({
        id: `tmdb-${item.id}`,
        type: 'movie',
        name: item.title,
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
        description: item.overview || 'No description available',
        releaseInfo: item.release_date ? item.release_date.split('-')[0] : 'Unknown'
    }));

    logger.info(`Catalog request processed. Query: "${searchQuery}", Results: ${metas.length}`);
    return { metas };
});

builder.defineMetaHandler(async (args) => {
    const id = args.id.split('-')[1];
    logger.debug(`Meta request received for movie ID: ${id}`);

    if (!metaCache[id]) {
        logger.warn(`Meta not found for movie ID: ${id}`);
        return { meta: null };
    }

    const movieData = metaCache[id].data;

    if (movieData.error) {
        logger.warn(`Meta request failed for movie ID: ${id}`);
        return { meta: null };
    }

    const { 
        title, 
        overview, 
        poster_path, 
        release_date, 
        genres, 
        runtime, 
        vote_average, 
        backdrop_path 
    } = movieData;

    logger.info(`Meta request processed for movie ID: ${id}`);
    return {
        meta: {
            id: args.id,
            type: 'movie',
            name: title || 'Unknown Title',
            poster: poster_path ? `https://image.tmdb.org/t/p/w500${poster_path}` : null,
            background: backdrop_path ? `https://image.tmdb.org/t/p/w1280${backdrop_path}` : null,
            description: overview || 'No description available',
            releaseInfo: release_date ? release_date.split('-')[0] : 'Unknown',
            genre: genres && Array.isArray(genres) ? genres.map(g => g.name) : [],
            runtime: runtime ? `${runtime} min` : 'Unknown',
            rating: vote_average ? vote_average.toFixed(1) : 'N/A',
        }
    };
});

async function startServer() {
    await ensureCacheDirectory();
    await loadCache();

    async function refreshCache() {
        logger.info('Scheduled update: Refreshing catalog and meta cache');
        await updateCatalogAndMetaCache();
    }

    // Schedule cache refresh every day at midnight
    schedule.scheduleJob('0 0 * * *', refreshCache);

    // Initial cache refresh if needed
    if (!catalogCache.timestamp || Date.now() - catalogCache.timestamp > 24 * 60 * 60 * 1000) {
        logger.info('Initial cache refresh needed');
        await refreshCache();
    } else {
        logger.info('Cache is up to date. Next refresh scheduled for midnight');
    }

    const interface = builder.getInterface();
    const port = process.env.PORT || 8082;

    logger.info(`Starting Stremio Add-on server on port ${port}`);
    serveHTTP(interface, { port });
}

startServer();
