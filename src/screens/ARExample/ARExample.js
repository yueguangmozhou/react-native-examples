import React from 'react';
import { View, PanResponder, Dimensions } from 'react-native';
import { GLView, Location, Permissions, MapView, FileSystem } from 'expo';
import debounce from 'lodash/debounce';
import { connect } from 'react-redux';
import * as THREE from 'three';
import * as turf from '@turf/turf';

require('three/examples/js/loaders/OBJLoader');
require('../../loaders/MTLLoader');

import { GEOMETRIES, MATERIALS } from './constants';
import HUD from './HUD';
import HUDSelection from './HUDSelection';
import GeometryListView from './GeometryListView';
import PolySearchView from './PolySearchView';
import Progress from './Progress';
import {
    getCameraPosition,
    calibrateObject,
    placeObject3DFromCamera,
    castPoint
} from './utils';
import {
    setupARKit,
    setInitialLocation,
    setLocation,
    setInitialHeading,
    setHeading,
    setRegion,
    addObject,
    addObjects,
    addObjectAtHeading,
    selectObject3D,
    reset,
    loadFromStorage
} from './actions/ar';
import LongpressControl from './LongpressControl';
import TransformControls from './TransformControls';
import TouchVisualizer from './TouchVisualizer';

const screen = Dimensions.get('window');
const ASPECT_RATIO = screen.width / screen.height;
const LATITUDE_DELTA = 0.001;
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;

// temporary save until i setup redux persist
const savedObjects = [
    // cvs
    {
        type: 'place',
        latitude: 32.782149,
        longitude: -96.805218
    },
    // tiff treats
    {
        type: 'place',
        latitude: 32.782521,
        longitude: -96.804757
    },
    // 7 11
    {
        type: 'place',
        latitude: 32.782232,
        longitude: -96.803999
    },
    // wine and spirits
    {
        type: 'place',
        latitude: 32.782422,
        longitude: -96.805492
    },
    // lot 041
    {
        type: 'place',
        latitude: 32.783134,
        longitude: -96.804276
    }
];

const createRegionWithLocation = location => ({
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    latitudeDelta: LATITUDE_DELTA,
    longitudeDelta: LONGITUDE_DELTA
});

const recalibrateThreshold = 1;

class ARExample extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            objects: []
        };
        /**
         * Subscriptions for location and heading tracking
         */
        this.subs = [];
        this.panResponder = PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onPanResponderGrant: this.handlePanResponderGrant,
            onPanResponderMove: this.handlePanResponderMove,
            onPanResponderRelease: this.handlePanResponderRelease,
            onPanResponderTerminate: this.handlePanResponderTerminate,
            onShouldBlockNativeResponder: () => false
        });
    }

    componentDidMount() {
        console.disableYellowBox = true;
    }

    componentWillUnmount() {
        console.disableYellowBox = false;

        // stop listening for location and heading
        this.subs.forEach(sub => sub.remove());

        // stop requestAnimationFrame infinite loop
        cancelAnimationFrame(this.requestID);

        this.props.reset();
    }

    shouldComponentUpdate(nextProps, nextState) {
        if (this.props.mapVisible !== nextProps.mapVisible) {
            return true;
        }
        if (nextProps.mapVisible) {
            if (this.props.currentLocation !== nextProps.currentLocation) {
                return true;
            }
            if (this.props.objects !== nextProps.objects) {
                return true;
            }
        }
        if (this.props.region !== nextProps.region) {
            return true;
        }
        return false;
    }

    init = async () => {
        await Permissions.askAsync(Permissions.LOCATION);
        await Promise.all([
            this.getCurrentPositionAsync(),
            this.getHeadingAsync()
        ]);
        await Promise.all([
            this.watchPositionAsync(),
            this.watchHeadingAsync()
        ]);
        this.props.loadFromStorage();
    };

    getCurrentPositionAsync = async () => {
        let location = await Location.getCurrentPositionAsync({
            enableHighAccuracy: true
        });
        this.props.setInitialLocation(location);
        this.props.setRegion(createRegionWithLocation(location));
    };

    /**
     * increment recalibrateCount after updating location
     * because we want to make sure all object3Ds are in an an accurate
     * spot no matter where you move by recalibrating the object3D position
     * after so many updates
     * TODO: recalibrate based on a radius from last calibration
     * if location distance from calibration location
     * is greater than threshold, recalibrate
     */
    watchPositionAsync = async () => {
        this.subs.push(
            await Location.watchPositionAsync(
                {
                    enableHighAccuracy: true
                },
                location => {
                    this.props.setLocation(location);
                    this.props.setRegion(createRegionWithLocation(location));
                    this.recalibrateCount = (this.recalibrateCount || 0) + 1;
                }
            )
        );
    };

    getHeadingAsync = async () => {
        const heading = await Location.getHeadingAsync();
        this.props.setInitialHeading(heading);
    };

    watchHeadingAsync = async () => {
        this.subs.push(
            await Location.watchHeadingAsync(heading => {
                this.props.setHeading(heading);
                // this.animateToBearing(heading);
            })
        );
    };

    // map

    // attempt to rotate map when heading changes
    // BUG: crashes
    animateToBearing = heading => {
        this.map && this.map.animateToBearing(heading);
    };
    animateToBearing = debounce(this.animateToBearing, 1000);

    onRegionChange = region => {
        this.props.setRegion(region);
    };

    onRegionChangeComplete = region => {
        this.props.setRegion(region);
    };

    // HUD

    // progress

    handleRemoteDownload = downloadProgress => {
        this.props.setProgress(
            downloadProgress.totalBytesWritten /
                downloadProgress.totalBytesExpectedToWrite *
                100
        );
    };

    renderObjectMarker = (obj, i) => {
        return (
            <MapView.Marker
                key={obj.id || `${obj.type}_${obj.latitude}_${obj.longitude}`}
                coordinate={{
                    latitude: obj.latitude,
                    longitude: obj.longitude
                }}
            />
        );
    };

    render() {
        return (
            <View style={{ flex: 1 }}>
                <GLView
                    {...this.panResponder.panHandlers}
                    ref={ref => (this._glView = ref)}
                    style={{ flex: 1 }}
                    onContextCreate={this._onGLContextCreate}
                />
                {this.props.currentLocation &&
                    this.props.mapVisible &&
                    this.props.region && (
                        <MapView
                            ref={c => (this.map = c)}
                            style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                right: 0,
                                height: '50%'
                            }}
                            initialRegion={this.props.region}
                            region={this.props.region}
                            onRegionChange={this.onRegionChange}
                            showsUserLocation={true}
                            followsUserLocation={true}
                        >
                            <MapView.Marker
                                coordinate={this.props.currentLocation.coords}
                            />
                            {this.props.objects.map(this.renderObjectMarker)}
                        </MapView>
                    )}
                <HUD />
                <HUDSelection />
                <GeometryListView />
                <PolySearchView />
                <Progress />
            </View>
        );
    }

    handlePanResponderGrant = (event, gestureState) => {
        this.longpressControl.handlePanResponderGrant(event, gestureState);
        this.touchVisualizer.handlePanResponderGrant(event, gestureState);
        let touch = castPoint(event.nativeEvent, {
            width: this.props.width,
            height: this.props.height
        });
        this.props.raycaster.setFromCamera(touch, this.props.camera);
        let intersects = this.props.raycaster.intersectObjects(
            this.props.object3Ds,
            true
        );
        console.log(
            'handlePanResponderGrant',
            this.props.object3Ds.length,
            intersects.length
        );
        if (intersects.length > 0) {
            const intersection = intersects[0];
            this.props.selectObject3D(intersection.object);
            this.transformControl.detach();
            this.transformControl.attach(intersection.object);
            this.transformControl.handlePanResponderGrant(event, gestureState);
            this.longpressControl.attach(intersection.object);
        }
    };

    handlePanResponderMove = (event, gestureState) => {
        this.transformControl.handlePanResponderMove(event, gestureState);
        this.longpressControl.handlePanResponderMove(event, gestureState);
    };

    handlePanResponderRelease = () => {
        this.transformControl.handlePanResponderRelease();
        this.longpressControl.handlePanResponderRelease();
        this.touchVisualizer.handlePanResponderRelease();
        // TODO: update latitude longitude and elevation changes from pan responder
    };

    handlePanResponderTerminate = () => {
        this.transformControl.handlePanResponderTerminate();
        this.longpressControl.handlePanResponderTerminate();
        this.touchVisualizer.handlePanResponderTerminate();
    };

    // adjust object3D positions to new geolocation
    recalibrate = () => {
        // animate could run before we have a location and heading
        if (!this.props.currentLocation || !this.props.initialHeading) {
            return;
        }

        const cameraPos = getCameraPosition(this.props.camera);
        this.props.objects.forEach(object =>
            calibrateObject(
                object,
                cameraPos,
                this.props.currentLocation.coords,
                this.props.initialHeading
            )
        );

        // reset recalibrate counter
        this.recalibrateCount = 0;
    };

    _onGLContextCreate = async gl => {
        // boilerplace arkit setup
        const { scene, camera, renderer } = await this.props.setupARKit(
            this._glView,
            gl
        );

        this.transformControl = new TransformControls(this.props.camera);
        this.longpressControl = new LongpressControl(this.props.camera);
        this.touchVisualizer = new TouchVisualizer(
            this.props.scene,
            this.props.camera
        );

        const animate = () => {
            // recalibrate only if geolocation updates a certain number of times
            // if (this.recalibrateCount >= recalibrateThreshold) {
            //     this.recalibrate();
            // }

            this.transformControl.update();
            this.longpressControl.update();

            this.requestID = requestAnimationFrame(animate);
            renderer.render(scene, camera);
            gl.endFrameEXP();
        };
        animate();

        // start geolocation and heading tracking here so the initial location and
        // initial heading is as accurate as possible
        this.init();
    };
}

const mapStateToProps = state => ({
    initialHeading: state.heading.initialHeading,
    currentHeading: state.heading.currentHeading,
    currentLocation: state.location.currentLocation,
    mapVisible: state.map.visible,
    region: state.region,
    ...state.three,
    objects: state.objects
});

const mapDispatchToProps = {
    setupARKit,
    setInitialLocation,
    setLocation,
    setInitialHeading,
    setHeading,
    setRegion,
    addObject,
    addObjects,
    addObjectAtHeading,
    selectObject3D,
    reset,
    loadFromStorage
};

export default connect(mapStateToProps, mapDispatchToProps)(ARExample);